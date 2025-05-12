import { getPlaceAndTakePerpOrderIx } from './worker-api';
import { PositionDirection, BN, PlaceAndTakeOrderSuccessCondition } from '@drift-labs/sdk';
import { convertToTransactionInstruction } from './utils';
import { Connection, TransactionMessage, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { Wallet, loadKeypair } from '@drift-labs/sdk';
import bs58 from 'bs58';

import config from '../../config.json';

async function main() {
  try {
    const connection = new Connection(config.rpcUrl, 'confirmed');
    const wallet = new Wallet(loadKeypair(config.keypairPath));

    const LAMPORTS_PER_SOL = 1000000000; // 1 billion lamports per SOL

    const baseAssetAmount = new BN(Math.floor(0.17 * LAMPORTS_PER_SOL));
    
    console.log('baseAssetAmount:', baseAssetAmount.toString());

    const response = await getPlaceAndTakePerpOrderIx(
      PositionDirection.LONG,
      0, // SOL-PERP
      0.17, 
      PlaceAndTakeOrderSuccessCondition.FullFill,
      9
    );

    console.log('response:', response);

    // const placeAndTakeIx = convertToTransactionInstruction(response.data.instruction);
    
    // const blockhash = await connection.getLatestBlockhash('confirmed');

    // const messageV0 = new TransactionMessage({
    //   payerKey: wallet.publicKey,
    //   recentBlockhash: blockhash.blockhash,
    //   instructions: [placeAndTakeIx]
    // }).compileToV0Message();
            
    // const tx = new VersionedTransaction(messageV0);
    // tx.sign([wallet.payer]);

    // const serializedTx = tx.serialize();
    // const base64Tx = bs58.encode(serializedTx);

    // // Simulate transaction first
    // const simulation = await connection.simulateTransaction(tx);
    // console.log('Simulation result:', simulation.value);

    // if (simulation.value.err) {
    //   throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    // }

    // console.log('Transaction ID:', bs58.encode(tx.signatures[0]));
    // console.log('Transaction:', base64Tx);

  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 