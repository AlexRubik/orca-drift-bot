import { createTransactionMessage, getBase64EncodedWireTransaction,
    Base64EncodedWireTransaction,
    decompileTransactionMessage,
    getCompiledTransactionMessageDecoder,
    signTransactionMessageWithSigners,
    createKeyPairSignerFromBytes,
    decompileTransactionMessageFetchingLookupTables,
    setTransactionMessageFeePayer,
    address,
    createSolanaRpc,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageFeePayerSigner
 } from "@solana/kit";

import fs from 'fs';
import path from 'path';

 const config = require(path.join(process.cwd(), 'config.json'));
  const keyPairBytes = new Uint8Array(JSON.parse(fs.readFileSync(config.keypairPath, 'utf8')));



 function base64ToArrayBuffer(base64: string): Uint8Array {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes;
  }

// API key setup
// const BASE_URL = 'https://api.ranger.finance'; // https://staging-sor-api-437363704888.asia-northeast1.run.app/v1
const BASE_URL = 'https://staging-sor-api-437363704888.asia-northeast1.run.app';
const API_KEY = 'sk_test_Mec3BDvGevY0OAsxsgdW6v2AxsETWf5gLPbxbBndvPM=';
const PUBKEY_STR = '6ZRD5HpC6vic6btP7yjii68ix9HZNoJr4tB9DJ4bBBGs';
const headers = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY
};



// Ranger Quote Types

// Fee breakdown structure
interface FeeBreakdown {
  base_fee: number;
  spread_fee: number;
  volatility_fee: number;
  margin_fee: number;
  close_fee: number;
  other_fees: number;
}

// Quote details
interface Quote {
  base: number;
  fee: number;
  total: number;
  fee_breakdown: FeeBreakdown;
}

// Venue information
interface Venue {
  venue_name: string;
  collateral: number;
  size: number;
  quote: Quote;
  order_available_liquidity: number;
  venue_available_liquidity: number;
}

// Complete quote response
interface RangerQuoteResponse {
  venues: Venue[];
  total_collateral: number;
  total_size: number;
  average_price: number;
}

// Using fetch API
const getQuote = async (): Promise<RangerQuoteResponse> => {
    const response = await fetch(`${BASE_URL}/v1/order_metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fee_payer: PUBKEY_STR, // Your Solana wallet public key
        symbol: "SOL",
        side: "Long",
        size: 1.0,
        collateral: 10.0,
        size_denomination: "SOL",
        collateral_denomination: "USDC",
        adjustment_type: "Increase"
      })
    });
  

  
    return response.json() as Promise<RangerQuoteResponse>;
  };
  
  // Example usage
//   getQuote()
//     .then(quote => {
//       console.log('Quote received:', quote)
//       console.log('Quote received:', quote.venues[0].quote)
//     })
//     .catch(error => console.error('Error:', error));
  
// Ranger Position Response Types
interface PositionResponse {
  message: Base64EncodedWireTransaction;  // Base64 encoded transaction
  meta: {
    venues: Venue[];
    total_collateral: number;
    total_size: number;
    average_price: number;
  };
}

// Using fetch API
const increasePosition = async (): Promise<PositionResponse> => {
  const response = await fetch(`${BASE_URL}/v1/increase_position`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fee_payer: PUBKEY_STR, // Your Solana wallet public key
      symbol: "SOL",
      side: "Long",
      size: 1.0,
      collateral: 10.0,
      size_denomination: "SOL",
      collateral_denomination: "USDC",
      adjustment_type: "Increase"
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Increase position request failed: ${error.message}`);
  }

  return response.json() as Promise<PositionResponse>;
};

// Example usage
async function main() {

    const wallet = await createKeyPairSignerFromBytes(keyPairBytes);

    const response = await increasePosition();
    console.log(response)
    console.log(response.meta)
    console.log(response.meta.venues[0].quote)

    const b64Txn = response.message.toString();

    const bytes = base64ToArrayBuffer(b64Txn);

    const decoder = getCompiledTransactionMessageDecoder();

    const decodedTxn = decoder.decode(bytes);

    console.log(decodedTxn);

    const rpc = createSolanaRpc(config.rpcUrl);

    const decompiledTxn = await decompileTransactionMessageFetchingLookupTables
    (
        decodedTxn,
        rpc

    )

    const blockhash = await rpc.getLatestBlockhash().send();


    let tx = setTransactionMessageLifetimeUsingBlockhash(blockhash.value, decompiledTxn);

    tx = setTransactionMessageFeePayerSigner(wallet, tx);

    const signedTxn = await signTransactionMessageWithSigners(tx);

    console.log('signedTxn', signedTxn);





    

  }

  main();
  