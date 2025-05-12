import { getPlacePerpOrderIx } from './worker-api.js';
import { OrderType, PositionDirection, BN, MarketType, OptionalOrderParams } from '@drift-labs/sdk';

async function main() {
  try {
    const orderParams: OptionalOrderParams = {
      marketIndex: 0,
      direction: PositionDirection.LONG,
      baseAssetAmount: new BN(1000),
      price: new BN(50000),
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      reduceOnly: false,
      userOrderId: 0,
      postOnly: false,
      immediateOrCancel: false,
      triggerPrice: new BN(0),
      triggerCondition: 0,
      oraclePriceOffset: null,
      auctionDuration: 0,
      auctionStartPrice: new BN(0),
      auctionEndPrice: new BN(0),
      maxTs: new BN(0)
    };

    const response = await getPlacePerpOrderIx(orderParams);
    console.log('Perp order instructions:', response.data); // Promise<TransactionInstruction>
  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 