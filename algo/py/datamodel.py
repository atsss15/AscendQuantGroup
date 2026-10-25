"""Data model for player algorithms. Mirrors IMC Prosperity's datamodel so the same code works in both."""
import json
from typing import Dict, List, Optional

Time = int
Symbol = str
Product = str
Position = int
UserId = str
ObservationValue = int


class Listing:
    def __init__(self, symbol: Symbol, product: Product, denomination: Product):
        self.symbol = symbol
        self.product = product
        self.denomination = denomination


class ConversionObservation:
    def __init__(self, bidPrice: float = 0.0, askPrice: float = 0.0, transportFees: float = 0.0,
                 exportTariff: float = 0.0, importTariff: float = 0.0, sugarPrice: float = 0.0, sunlightIndex: float = 0.0):
        self.bidPrice = bidPrice
        self.askPrice = askPrice
        self.transportFees = transportFees
        self.exportTariff = exportTariff
        self.importTariff = importTariff
        self.sugarPrice = sugarPrice
        self.sunlightIndex = sunlightIndex


class Observation:
    def __init__(self, plainValueObservations: Dict[Product, ObservationValue],
                 conversionObservations: Dict[Product, ConversionObservation]):
        self.plainValueObservations = plainValueObservations
        self.conversionObservations = conversionObservations

    def __str__(self) -> str:
        return "(plainValueObservations: " + json.dumps(self.plainValueObservations) + ", conversionObservations: " + str(self.conversionObservations) + ")"


class Order:
    def __init__(self, symbol: Symbol, price: int, quantity: int) -> None:
        self.symbol = symbol
        self.price = price
        self.quantity = quantity  # positive = buy, negative = sell

    def __str__(self) -> str:
        return "(" + self.symbol + ", " + str(self.price) + ", " + str(self.quantity) + ")"

    def __repr__(self) -> str:
        return self.__str__()


class OrderDepth:
    def __init__(self):
        self.buy_orders: Dict[int, int] = {}   # price -> volume (positive)
        self.sell_orders: Dict[int, int] = {}  # price -> volume (negative)


class Trade:
    def __init__(self, symbol: Symbol, price: int, quantity: int, buyer: Optional[UserId] = None,
                 seller: Optional[UserId] = None, timestamp: int = 0) -> None:
        self.symbol = symbol
        self.price: int = price
        self.quantity: int = quantity
        self.buyer = buyer
        self.seller = seller
        self.timestamp = timestamp

    def __str__(self) -> str:
        return "(" + self.symbol + ", " + str(self.buyer) + " << " + str(self.seller) + ", " + str(self.price) + ", " + str(self.quantity) + ", " + str(self.timestamp) + ")"

    def __repr__(self) -> str:
        return self.__str__()


class TradingState(object):
    def __init__(self, traderData: str, timestamp: Time, listings: Dict[Symbol, Listing],
                 order_depths: Dict[Symbol, OrderDepth], own_trades: Dict[Symbol, List[Trade]],
                 market_trades: Dict[Symbol, List[Trade]], position: Dict[Product, Position], observations: Observation):
        self.traderData = traderData
        self.timestamp = timestamp
        self.listings = listings
        self.order_depths = order_depths
        self.own_trades = own_trades
        self.market_trades = market_trades
        self.position = position
        self.observations = observations

    def toJSON(self):
        return json.dumps(self, default=lambda o: o.__dict__, sort_keys=True)


class ProsperityEncoder(json.JSONEncoder):
    def default(self, o):
        return o.__dict__
