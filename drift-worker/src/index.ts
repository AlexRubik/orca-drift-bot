import bs58 from 'bs58';
import { 
  Transaction, 
  sendAndConfirmTransaction, 
  Connection, 
  TransactionMessage, 
  VersionedTransaction, 
  TransactionInstruction, 
  PublicKey,
  Keypair
} from '@solana/web3.js';
import { BN, MarketType, PlaceAndTakeOrderSuccessCondition, PositionDirection, Wallet, loadKeypair } from '@drift-labs/sdk';
import { convertToTransactionInstruction, createComputeUnitIx, getSignatureStatuses } from './utils';
import { getInitUserAndDepositIx } from './worker-api';
import { getJitoTipIx } from './jito';
const config = require('../../config.json');

async function main() {
  try {
    const connection = new Connection(config.rpcUrl, 'confirmed');
    const wallet = new Wallet(loadKeypair(config.keypairPath));

    // Get instructions for both operations
    // const initResponse = await getInitUserInstructions(0, 'LP Bot');

    // const depositResponse = await getDepositInstruction(
    //   0,
    //   50,
    //   0,
    //   false,
    //   false
    // );

    const initAndDepositResponse = await getInitUserAndDepositIx(
      50,
      0,
      0,
      'LP Bot'
    );

    // const takeAndPlaceResponse = await getPlaceAndTakePerpOrderIx(
    //   PositionDirection.LONG,
    //   0,
    //   new BN(5000),
    //   PlaceAndTakeOrderSuccessCondition.FullFill
    // );
    
    // Convert user stats instruction
    // const userStatsIx = convertToTransactionInstruction(initResponse.data.statIx);

    // // Convert init instruction
    // const initIx = convertToTransactionInstruction(initResponse.data.initIx);

    // const depositIx = convertToTransactionInstruction(depositResponse.data.instruction);

    // const userAccountPublicKey = new PublicKey(initResponse.data.pubkey);

    const allIxs = [];

    const initAndDepositIxs: any[] = initAndDepositResponse.data.instructions;

    // iterate through all the ixs, convert them and add them to the allIxs array
    for (const ix of initAndDepositIxs) {
      allIxs.push(convertToTransactionInstruction(ix));
    }

    const jitoTipIx = await getJitoTipIx(0.001, wallet.publicKey);
    allIxs.push(jitoTipIx);

    // const placeAndTakeIx = convertToTransactionInstruction(takeAndPlaceResponse.data.instruction);

    // allIxs.push(placeAndTakeIx);
    
    const blockhash = await connection.getLatestBlockhash('confirmed');

    let messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: allIxs
    }).compileToV0Message();
            
    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet.payer]);

    const serializedTx = tx.serialize();
    const base64Tx = bs58.encode(serializedTx);

    // Simulate transaction first
    const simulation = await connection.simulateTransaction(tx);
    const CUs = simulation.value.unitsConsumed;
    // create a compute unit instruction and prepend it to the instructions array
    const computeUnitIx = CUs ? createComputeUnitIx(CUs + 5000) : createComputeUnitIx(300000);
    allIxs.unshift(computeUnitIx);

    console.log('Simulation result:', simulation.value);

    if (simulation.value.err) {
      throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    // Only log essential info
    // console.log('User Account PublicKey:', userAccountPublicKey.toString());
    console.log('Transaction ID:', bs58.encode(tx.signatures[0]));
    // console.log('Transaction:', base64Tx);

    // create and sign new txn with the compute unit instruction
 
    const message2V0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: allIxs
    }).compileToV0Message();


    const newTx = new VersionedTransaction(message2V0);
    newTx.sign([wallet.payer]);
    const serializedNewTx = newTx.serialize();
    const rawTx = Buffer.from(serializedNewTx).toString('base64');
    

    // simulate the new txn
    const simulation2 = await connection.simulateTransaction(newTx);
    console.log('Simulation result:', simulation2.value);
    // txn id
    const txnId = bs58.encode(newTx.signatures[0]);
    console.log('New Raw Transaction:', rawTx);
    console.log('Transaction ID:', txnId);

    const testId = '5NbPkpvHT26H6Nj9wCcAGjk2QfUkrcYbFCyPf29xGhpn6Pv3WfkgKu1y3KouDnkZaQmJUEaYejmpVRMAA4UssCQo'

    // check if the txn is confirmed or finalized
    const txnStatus = await getSignatureStatuses(config.rpcUrl, [testId]);
    console.log('txnStatus:', txnStatus);
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
