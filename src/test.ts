import { initUserAndDeposit, placeAndTakePerpOrder, getPositionDetails, getUser } from "./drift/drift-worker-interface";
import { address, createKeyPairSignerFromBytes, createSolanaRpc, IInstruction, mainnet } from "@solana/web3.js";
import { Address } from '@solana/web3.js';
import path from "path";
import fs from 'fs';
import { sendTransactionWithPriorityFee, sendUsdcProtocolFee } from "./utils";
import { PlaceAndTakeOrderSuccessCondition, PositionDirection } from "./drift/drift-worker-types";
import BN from 'bn.js';
import { manageShortPositions } from "./drift/drift-utils";
import { swapToken } from "./positionManagement";
import { getCoinHourly, getMomentumMetrics } from "./strats/momentum";
import { getPythPrice } from "./pyth";

async function main() {
    // const initResponse = await getInitUserAndDepositIx(50, 0, 0, 'LP Bot');

    // console.log('initResponse:', initResponse);

    const solMarketIndex = 0;
    const solDecimals = 9;

    // const perpLongResponse = await getPlaceAndTakePerpOrder(
    //     PositionDirection.LONG,
    //     solMarketIndex,
    //     2.5,
    //     PlaceAndTakeOrderSuccessCondition.FullFill,
    //     solDecimals
    // )

    // const positionDetails = await getPositionDetails(solMarketIndex, solDecimals);


    // console.log('perpLongResponse:', perpLongResponse);

// await manageShortPositions(
//     5,
//     'So11111111111111111111111111111111111111112',
//     'So11111111111111111111111111111111111111112',
//     9,
//     6,
//     0.05,
//     0.05,
//     1,
//     22
// )


const config = require(path.join(process.cwd(), 'config.json'));
const keypairPath = config.keypairPath;
const rpcUrl = config.rpcUrl;


  const keyPairBytes = new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const wallet = await createKeyPairSignerFromBytes(keyPairBytes);
const mainnetRpc = createSolanaRpc(mainnet(rpcUrl));

// await sendUsdcProtocolFee(
//     mainnetRpc,
//     wallet,
//     0.05
// )

// const x = await swapToken(
//     mainnetRpc,
//     BigInt(100),
//     address('So11111111111111111111111111111111111111112'),
//     address('FEdiCTVkcSQ8WzDqh7VBtw1eQnoaLXpECcSexEorbGY'),
//     100,
//     wallet,
//     1
// )

  // Example usage:

  // log the first 3 and last 3 elements of the array
  getCoinHourly(2, 'solana')
    .then(data => {
      console.log("First 3 elements:", data.dataArray.slice(0, 3))
      console.log('...**************************************************...')
      console.log("Last 3 elements:", data.dataArray.slice(-3))
      console.log('First element:', new Date(data.dataArray[0].unixTimestamp).toISOString())
      console.log('Last element:', new Date(data.dataArray[data.dataArray.length - 1].unixTimestamp).toISOString())
      // log the length of the array
      console.log('Length of array:', data.dataArray.length)

      const momentumMetrics = getMomentumMetrics(data.basicPriceDataArray);
      console.log('Momentum metrics:', momentumMetrics);
    })
    .catch(error => console.error(error));

    const pythPrice = await getPythPrice();
    console.log('Pyth price:', pythPrice);
}

main();
