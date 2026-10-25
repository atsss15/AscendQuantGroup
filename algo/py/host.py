"""
Runs one player's Trader in a separate process.

Protocol: the first line on stdin is {"code": ..., "cpuSeconds": ...}. Then one JSON TradingState per line;
for each, one JSON reply line goes to file descriptor 3: {"orders": [...], "traderData": str, "logs": [...], "error": str|null}.
Anything the player prints is captured into "logs".

Sandbox (defence in depth, not a security boundary): the process starts with a clean environment and a temp
working directory, CPU time and file-size limits, a restricted import list, no `open`, and an audit hook that
refuses file access outside the Python installation, network sockets, subprocesses and similar operations.
"""
import builtins
import io
import json
import os
import resource
import sys
import sysconfig
import traceback

RUNTIME_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RUNTIME_DIR)
proto = os.fdopen(3, "w", buffering=1)

ALLOWED_IMPORTS = {
    "datamodel", "typing", "math", "statistics", "json", "jsonpickle", "numpy", "pandas", "collections", "itertools",
    "functools", "heapq", "bisect", "random", "dataclasses", "string", "copy", "decimal", "fractions", "operator",
    "re", "enum", "abc", "time", "datetime", "__future__", "cmath", "array", "pickle", "base64", "zlib",
}
for name in ["math", "statistics", "json", "collections", "itertools", "functools", "heapq", "bisect", "random",
             "dataclasses", "string", "copy", "decimal", "fractions", "operator", "re", "enum", "abc", "time",
             "datetime", "cmath", "array", "pickle", "base64", "zlib", "typing", "datamodel", "numpy", "pandas", "jsonpickle"]:
    try:
        __import__(name)
    except Exception:
        ALLOWED_IMPORTS.discard(name)


def reply(obj):
    proto.write(json.dumps(obj) + "\n")
    proto.flush()


def main():
    setup = json.loads(sys.stdin.readline())
    cpu = int(setup.get("cpuSeconds", 120))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    except (ValueError, OSError):
        pass

    try:
        code = compile(setup["code"], "trader.py", "exec")
    except SyntaxError as e:
        reply({"fatal": f"SyntaxError in your code, line {e.lineno}: {e.msg}"})
        return

    install_audit_hook()

    real_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if level == 0 and root not in ALLOWED_IMPORTS:
            raise ImportError(f"import of '{name}' is not allowed here. Allowed: {', '.join(sorted(ALLOWED_IMPORTS))}")
        return real_import(name, globals, locals, fromlist, level)

    safe_builtins = dict(vars(builtins))
    for blocked in ("open", "input", "breakpoint", "help", "exit", "quit", "compile"):
        safe_builtins.pop(blocked, None)
    safe_builtins["__import__"] = guarded_import

    module = {"__name__": "trader", "__builtins__": safe_builtins}
    out = io.StringIO()
    try:
        sys.stdout = out
        exec(code, module)
        trader = module["Trader"]()
    except Exception:
        sys.stdout = sys.__stdout__
        reply({"fatal": "Your code failed to load:\n" + short_traceback(), "logs": lines(out.getvalue())})
        return
    sys.stdout = sys.__stdout__
    reply({"ready": True, "logs": lines(out.getvalue())})

    from datamodel import TradingState, OrderDepth, Trade, Listing, Observation

    for raw in sys.stdin:
        msg = json.loads(raw)
        state = TradingState(
            traderData=msg.get("traderData", ""),
            timestamp=msg["timestamp"],
            listings={s: Listing(l["symbol"], l["product"], l["denomination"]) for s, l in msg["listings"].items()},
            order_depths={s: depth(d) for s, d in msg["order_depths"].items()},
            own_trades={s: [Trade(**t) for t in ts] for s, ts in msg["own_trades"].items()},
            market_trades={s: [Trade(**t) for t in ts] for s, ts in msg["market_trades"].items()},
            position=dict(msg.get("position", {})),
            observations=Observation(msg.get("observations", {}).get("plain", {}), {}),
        )
        out = io.StringIO()
        sys.stdout = out
        sys.stderr = out
        error = None
        orders, trader_data = [], msg.get("traderData", "")
        try:
            result = trader.run(state)
            orders, trader_data = unpack(result, trader_data)
        except Exception:
            error = short_traceback()
        finally:
            sys.stdout = sys.__stdout__
            sys.stderr = sys.__stderr__
        reply({"orders": orders, "traderData": trader_data, "logs": lines(out.getvalue()), "error": error})


def depth(d):
    from datamodel import OrderDepth
    od = OrderDepth()
    od.buy_orders = {int(p): int(v) for p, v in d.get("buy_orders", {}).items()}
    od.sell_orders = {int(p): int(v) for p, v in d.get("sell_orders", {}).items()}
    return od


def unpack(result, trader_data):
    """Accept Prosperity's (orders, conversions, traderData) tuple, or just the orders dict."""
    if isinstance(result, tuple):
        orders_by_symbol = result[0] if len(result) > 0 else {}
        if len(result) > 2 and result[2] is not None:
            trader_data = result[2] if isinstance(result[2], str) else str(result[2])
    else:
        orders_by_symbol = result or {}
    orders = []
    for symbol, lst in (orders_by_symbol or {}).items():
        for o in lst or []:
            price, qty = o.price, o.quantity
            if isinstance(price, float) and price.is_integer():
                price = int(price)
            if isinstance(qty, float) and qty.is_integer():
                qty = int(qty)
            if hasattr(price, "item"):  # numpy scalars
                price = price.item()
            if hasattr(qty, "item"):
                qty = qty.item()
            orders.append({"symbol": o.symbol if getattr(o, "symbol", None) else symbol, "price": price, "quantity": qty})
    return orders, trader_data


def lines(text, limit=4000):
    text = text[:limit]
    return [l for l in text.splitlines() if l.strip()][:50]


def short_traceback():
    tb = traceback.format_exc().strip().splitlines()
    # hide this file's frames
    keep = [l for l in tb if "host.py" not in l]
    return "\n".join(keep[-12:])


def install_audit_hook():
    roots = {os.path.realpath(p) for p in {
        sys.prefix, sys.base_prefix, sys.exec_prefix, RUNTIME_DIR,
        *(v for k, v in sysconfig.get_paths().items() if v),
    }}
    roots = tuple(r.rstrip("/") + "/" for r in roots)
    blocked_prefixes = (
        "socket.", "subprocess.", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty",
        "os.kill", "os.killpg", "os.remove", "os.unlink", "os.rename", "os.replace", "os.rmdir", "os.mkdir",
        "os.chmod", "os.chown", "os.symlink", "os.link", "os.truncate", "os.putenv", "os.unsetenv", "os.chdir",
        "os.chroot", "os.startfile", "os.setxattr", "os.removexattr", "shutil.", "ctypes.", "urllib.", "http.",
        "ftplib.", "smtplib.", "imaplib.", "poplib.", "nntplib.", "telnetlib.", "webbrowser.", "pty.", "sys.addaudithook",
        "sys.settrace", "sys.setprofile", "resource.setrlimit", "fcntl.", "mmap.", "signal.", "_thread.start_new_thread",
    )

    def allowed_path(path):
        if isinstance(path, int):
            return True
        try:
            real = os.path.realpath(os.fsdecode(path))
        except Exception:
            return False
        return any((real + "/").startswith(r) for r in roots)

    def hook(event, args):
        if event == "open":
            path, mode = args[0], args[1] if len(args) > 1 else "r"
            if isinstance(mode, str) and any(c in mode for c in "wax+"):
                raise PermissionError("Writing files is disabled")
            if not allowed_path(path):
                raise PermissionError("File access is disabled")
        elif event in ("os.listdir", "os.scandir"):
            if args and not allowed_path(args[0] if args[0] is not None else "."):
                raise PermissionError("File access is disabled")
        elif event.startswith(blocked_prefixes):
            raise PermissionError(f"'{event}' is disabled")

    sys.addaudithook(hook)


if __name__ == "__main__":
    main()
