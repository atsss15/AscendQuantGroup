import fs from 'node:fs';
import os from 'node:os';

/**
 * What the Fly.io hosting costs, for the admin panel.
 *
 * Fly's API doesn't report the bill itself, so this estimates it from what the app runs (machine size, volume)
 * and Fly's list prices, assuming the machine runs all the time (it does: auto-stop is off). With a read-only
 * token in FLY_API_TOKEN (`fly tokens create readonly`) it also reads the exact machine and volume sizes, the
 * data sent out this month, and the organization's billing status. The exact bill is on the Fly dashboard.
 */
export const PRICES = {
  asOf: '2025 list prices, US/EU regions',
  sharedCpuMonth: 1.94, // shared-cpu-1x with 256 MB, per vCPU
  performanceCpuMonth: 31.0, // performance vCPU with 2 GB
  extraRamGbMonth: 5.0,
  volumeGbMonth: 0.15,
  dataOutGb: 0.02,
};

const HOUR = 3600_000;
let cache = null;

export async function hostingInfo({ now = Date.now(), dataDir = process.env.DATA_DIR ?? 'data' } = {}) {
  const app = process.env.FLY_APP_NAME;
  if (!app) return { onFly: false, note: 'This server is not running on Fly.io (no FLY_APP_NAME).' };
  if (cache && now - cache.at < 10 * 60_000) return cache.info;

  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const monthEnd = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
  const monthHours = (monthEnd - monthStart) / HOUR;
  const hoursSince = (created) => Math.max(0, (now - Math.max(monthStart, Date.parse(created) || monthStart)) / HOUR);

  // what this machine knows about itself
  let machines = [{ id: process.env.FLY_MACHINE_ID, cpuKind: 'shared', cpus: os.cpus().length, memoryMb: Number(process.env.FLY_VM_MEMORY_MB) || Math.round(os.totalmem() / 2 ** 20), created: null, state: 'started' }];
  let volumes = [];
  try {
    const st = fs.statfsSync(dataDir);
    volumes = [{ name: 'data', sizeGb: Math.max(1, Math.round((st.blocks * st.bsize) / 1e9)), created: null }];
  } catch {
    // no volume info
  }
  let billing = null;
  let dataOutGb = null;
  const errors = [];

  const token = process.env.FLY_API_TOKEN;
  if (token) {
    const auth = token.startsWith('FlyV1 ') ? token : `Bearer ${token}`;
    const get = async (url) => {
      const res = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`${new URL(url).pathname}: ${res.status}`);
      return res.json();
    };
    try {
      machines = (await get(`https://api.machines.dev/v1/apps/${app}/machines`)).map((m) => ({
        id: m.id,
        cpuKind: m.config?.guest?.cpu_kind ?? 'shared',
        cpus: m.config?.guest?.cpus ?? 1,
        memoryMb: m.config?.guest?.memory_mb ?? 256,
        created: m.created_at,
        state: m.state,
      }));
      volumes = (await get(`https://api.machines.dev/v1/apps/${app}/volumes`)).map((v) => ({ name: v.name, sizeGb: v.size_gb, created: v.created_at }));
    } catch (err) {
      errors.push(`machines: ${err.message}`);
    }
    try {
      const res = await fetch('https://api.fly.io/graphql', {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ app(name: "${app}") { organization { slug billingStatus creditBalanceFormatted isCreditCardSaved } usage { ts totalDataOutGB } } }` }),
        signal: AbortSignal.timeout(8000),
      }).then((r) => r.json());
      const a = res.data?.app;
      if (a?.organization) {
        billing = { status: a.organization.billingStatus, credits: a.organization.creditBalanceFormatted, cardOnFile: a.organization.isCreditCardSaved, org: a.organization.slug };
      }
      if (Array.isArray(a?.usage)) dataOutGb = a.usage.filter((u) => Date.parse(u.ts) >= monthStart).reduce((s, u) => s + (u.totalDataOutGB ?? 0), 0);
      if (res.errors?.length) errors.push(`billing: ${res.errors[0].message}`);
    } catch (err) {
      errors.push(`billing: ${err.message}`);
    }
  }

  const machineMonth = (m) => {
    const gb = m.memoryMb / 1024;
    return m.cpuKind === 'performance'
      ? m.cpus * PRICES.performanceCpuMonth + Math.max(0, gb - 2 * m.cpus) * PRICES.extraRamGbMonth
      : m.cpus * PRICES.sharedCpuMonth + Math.max(0, gb - 0.25 * m.cpus) * PRICES.extraRamGbMonth;
  };
  const running = machines.filter((m) => m.state === 'started');
  const perMonth = running.reduce((s, m) => s + machineMonth(m), 0) + volumes.reduce((s, v) => s + v.sizeGb * PRICES.volumeGbMonth, 0);
  const soFar =
    running.reduce((s, m) => s + (machineMonth(m) * hoursSince(m.created)) / monthHours, 0) +
    volumes.reduce((s, v) => s + (v.sizeGb * PRICES.volumeGbMonth * hoursSince(v.created)) / monthHours, 0) +
    (dataOutGb ?? 0) * PRICES.dataOutGb;
  const round = (x) => Math.round(x * 100) / 100;

  const info = {
    onFly: true,
    app,
    region: process.env.FLY_REGION,
    machines: machines.map((m) => ({ size: `${m.cpuKind}-cpu-${m.cpus}x, ${m.memoryMb} MB`, state: m.state, perMonth: round(machineMonth(m)) })),
    volumes: volumes.map((v) => ({ sizeGb: v.sizeGb })),
    dataOutGb: dataOutGb == null ? null : round(dataOutGb),
    estimate: { monthToDate: round(soFar), perMonth: round(perMonth) },
    billing,
    detailed: !!token,
    errors,
    prices: PRICES.asOf,
    dashboard: `https://fly.io/dashboard/${billing?.org ?? 'personal'}/billing`,
  };
  cache = { at: now, info };
  return info;
}
