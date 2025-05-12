// export async function to get jito tip data from https://bundles.jito.wtf/api/v1/bundles/tip_floor
// example output: 
// [{"time":"2025-01-11T00:39:46Z","landed_tips_25th_percentile":3.281e-6,"landed_tips_50th_percentile":0.000012536000000000002,"landed_tips_75th_percentile":0.00005,"landed_tips_95th_percentile":0.005,"landed_tips_99th_percentile":0.011160000000000028,"ema_landed_tips_50th_percentile":0.00010978950949063134}]

import { getTransferSolInstruction } from "@solana-program/system";
import { address, Address, IInstruction, TransactionSigner } from "@solana/web3.js";

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
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json() as JitoBundleResponse;
    return data.result;  // Returns the bundle ID
  } catch (error) {
    console.error('Error sending Jito bundle:', error);
    throw error;
  }
}

// get jito tip instruction

export async function getJitoTipIxn(
  fromKeypair: TransactionSigner,
  overrideTipSol?: number  // Optional override in SOL
): Promise<IInstruction> {
  const LAMPORTS_PER_SOL = 1_000_000_000;
  let lamports: bigint;

  // If override is provided, use it directly
  if (typeof overrideTipSol === 'number') {
    lamports = BigInt(Math.floor(overrideTipSol * LAMPORTS_PER_SOL));
    console.log(`Using override tip amount: ${overrideTipSol} SOL (${lamports} lamports)`);
  } else {
    // Existing logic for dynamic tip calculation
    lamports = BigInt(Math.floor(0.0001 * LAMPORTS_PER_SOL));
    
    try {
      const tipData = await getJitoTipData();
      lamports = BigInt(Math.floor(tipData.landed_tips_75th_percentile * LAMPORTS_PER_SOL));
      console.log('75th percentile tip:', tipData.landed_tips_75th_percentile);
      
      if (lamports > BigInt(Math.floor(0.002 * LAMPORTS_PER_SOL))) {
        console.log('Using 0.002 SOL as default');
        lamports = BigInt(Math.floor(0.002 * LAMPORTS_PER_SOL));
      }
    } catch (error) {
      console.error('Error getting Jito tip data:', error);
      console.log('Using 0.002 SOL as default');
      lamports = BigInt(Math.floor(0.002 * LAMPORTS_PER_SOL));
    }
  }

  // get destination address from tipAccounts
  const destinationAddress = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];

  const instruction = getTransferSolInstruction({
    amount: lamports,
    destination: address(destinationAddress),
    source: fromKeypair,
  });

  return instruction;
}