import bs58 from 'bs58';
import { Wallet } from '@drift-labs/sdk';
import { PublicKey, TransactionInstruction, SystemProgram, Connection, RpcResponseAndContext } from '@solana/web3.js';
import { 
    TransactionMessage, 
    VersionedTransaction 
} from '@solana/web3.js';
import { createComputeUnitIx } from './utils';
import { AddressLookupTableAccount } from '@solana/web3.js';

const DEBUG = false;

type JitoTipData = {
    time: string;
    landed_tips_25th_percentile: number;
    landed_tips_50th_percentile: number;
    landed_tips_75th_percentile: number;
    landed_tips_95th_percentile: number;
    landed_tips_99th_percentile: number;
    ema_landed_tips_50th_percentile: number;
  }
  
  const tipAccounts = [
      "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
      "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
      "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
      "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
      "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
      "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
      "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"
  ]
  
  export async function getJitoTipData(): Promise<JitoTipData> {
    const response = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
    const data = await response.json();
    return data[0];
  }
  
  type JitoBundleResponse = {
    jsonrpc: "2.0";
    result: string;  // Bundle ID
    id: 1;
  }
  
  export async function sendJitoBundle(base64Transactions: string[]): Promise<string> {
    try {
      const response = await fetch('https://mainnet.block-engine.jito.wtf:443/api/v1/bundles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [
            base64Transactions,
            {
              encoding: 'base64'
            }
          ]
        })
      });
  
      if (!response.ok) {
        const errorText = await response.text();
        console.log("Response status:", response.status);
        console.log("Error details:", errorText);
        throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
      }
  
      const data = await response.json() as JitoBundleResponse;
      return data.result;  // Returns the bundle ID
    } catch (error) {
      console.error('Error sending Jito bundle:', error);
      throw error;
    }
  }

export async function getJitoTipIx(maxJitoTipInSol: number = 0.001, fromPubkey: PublicKey, tipOverrideInSol?: number): Promise<TransactionInstruction> {
    const tipAccount = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);

    let perc75th = maxJitoTipInSol;

    try {
      perc75th = (await getJitoTipData()).landed_tips_75th_percentile;
    } catch (error) {
      console.error("Error getting Jito tip data:", error);
      // using maxJitoTipInSol / 2
      perc75th = maxJitoTipInSol / 2;
    }

    if (perc75th > maxJitoTipInSol) {
      console.log("Jito 75th percentile tip is greater than maxJitoTipInSol, using maxJitoTipInSol: ", maxJitoTipInSol);
    } else {
      console.log("Jito using 75th percentile tip of", perc75th, "SOL");
    }

    let lamports = Math.min(Math.floor(perc75th * 1e9), maxJitoTipInSol * 1e9); // Convert SOL to lamports
    if (tipOverrideInSol) {
      console.log("Using override tip of", tipOverrideInSol, "SOL");
      lamports = Math.floor(tipOverrideInSol * 1e9);
    }

    return SystemProgram.transfer({
        fromPubkey: fromPubkey,
        toPubkey: tipAccount,
        lamports
    });
}

// type for the return value of buildAndSendJitoBundle
type JitoBundleResult = {
    bundleId: string;
    txnId: string;
    base64Tx: string;
}

export async function buildAndSendJitoBundle(
    instructions: TransactionInstruction[],
    wallet: Wallet,
    rpcUrl: string,
    maxJitoTipInSol: number = 0.001,
    tipOverrideInSol?: number,
    simulateForCU: boolean = false,
    addressLookupTableAccs?: string[]
): Promise<JitoBundleResult> {
    const connection = new Connection(rpcUrl, 'confirmed');
    
    // get address lookup tables if provided
    let addressLookupTables: AddressLookupTableAccount[] = [];
    if (addressLookupTableAccs && addressLookupTableAccs.length > 0) {
      DEBUG ? console.log("Getting address lookup tables for:", addressLookupTableAccs) : null;
      
      // Fetch all lookup tables in parallel
      const lookupTablePromises = addressLookupTableAccs.map(acc => 
        connection.getAddressLookupTable(new PublicKey(acc))
      );
      
      const lookupTableResponses = await Promise.all(lookupTablePromises);
      
      // Filter out any null values and extract the actual table accounts
      addressLookupTables = lookupTableResponses
        .filter(response => response.value !== null)
        .map(response => response.value as AddressLookupTableAccount);
      
      if (DEBUG) {
        console.log(`Retrieved ${addressLookupTables.length} lookup tables out of ${addressLookupTableAccs.length} requested`);
      }
    }

    if (addressLookupTableAccs && addressLookupTableAccs.length > 0 && addressLookupTables.length === 0) {
      throw new Error("None of the provided address lookup tables were found");
    }

    // Add Jito tip instruction
    const jitoTipIx = await getJitoTipIx(maxJitoTipInSol, wallet.publicKey, tipOverrideInSol);
    let allIxs = [createComputeUnitIx(300000), jitoTipIx, ...instructions];
    const blockhash = await connection.getLatestBlockhash('confirmed');
    console.log("Got blockhash:", blockhash);

    if (simulateForCU) {
      console.log("Simulating for CU");
        // Build initial transaction for simulation
        const simMessage = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash.blockhash,
            instructions: [...allIxs]
        }).compileToV0Message(addressLookupTables);

        // created message
        console.log("Created message");

        const simTx = new VersionedTransaction(simMessage);
        console.log("Versioned tx created for sim");

        simTx.sign([wallet.payer]);
        // signed simTx
        console.log("Signed simTx");

        // Simulate to get compute units
        const simulation = await connection.simulateTransaction(simTx);
        console.log("Simulated transaction");
        const CUs = simulation.value.unitsConsumed;
        console.log("CUs:", CUs);
        const computeUnitIx = createComputeUnitIx(CUs ? CUs + 50000 : 350000);
        allIxs[0] = computeUnitIx;
        console.log("Created compute unit ix");
        console.log("Added compute unit ix to allIxs");

        // log base64Tx 
        // serialize and then log
        const serializedTx = simTx.serialize();
        DEBUG ? console.log("Serialized tx:", serializedTx) : null;
        const base64Tx = Buffer.from(serializedTx).toString('base64');
        DEBUG ? console.log("base64Tx:", base64Tx) : null;
    } else {
        const computeUnitIx = createComputeUnitIx(350000);
        console.log("Created compute unit ix");
        allIxs[0] = computeUnitIx;
        console.log("Added compute unit ix to allIxs");
    }

    // get new blockhash
    const newBlockhash = await connection.getLatestBlockhash('confirmed');
    DEBUG ? console.log("Got new blockhash:", newBlockhash) : null;

    // Build final transaction
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: newBlockhash.blockhash,
        instructions: allIxs
    }).compileToV0Message(addressLookupTables.length > 0 ? addressLookupTables : undefined);

    console.log("Created final message");

    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet.payer]);

    console.log("Signed transaction");

    // Serialize and encode transaction
    const serializedTx = tx.serialize();
    console.log("Serialized transaction");
    const base64Tx = Buffer.from(serializedTx).toString('base64');
    console.log("Encoded transaction");

    DEBUG ? console.log('base64Tx:', base64Tx): null;

    const txnId = bs58.encode(tx.signatures[0]);
    console.log('txnId:', txnId);
    // Send as Jito bundle

    const bundleId = await sendJitoBundle([base64Tx]);
    console.log('bundleId:', bundleId);
    return {
      bundleId,
       txnId,
       base64Tx
      };
}
