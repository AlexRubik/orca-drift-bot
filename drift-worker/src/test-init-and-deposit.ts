import { getInitUserAndDepositIx } from './worker-api.js';
import { BN, Wallet, loadKeypair } from '@drift-labs/sdk';
import { convertToTransactionInstruction } from './utils.js';
import { Connection, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

import config from '../../config.json';
async function main() {
  try {
    const connection = new Connection(config.rpcUrl, 'confirmed');
    const wallet = new Wallet(loadKeypair(config.keypairPath));
    
    const response = await getInitUserAndDepositIx(
      50, // 50 USDC
      0, // USDC market index
      0, // subaccount ID
      'rude'
    );

    const instructions = response.data.instructions.map((ix: any) => 
      convertToTransactionInstruction(ix)
    );
    
    const blockhash = await connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions
    }).compileToV0Message();
            
    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet.payer]);

    const serializedTx = tx.serialize();
    const base64Tx = bs58.encode(serializedTx);

    // Simulate transaction first
    const simulation = await connection.simulateTransaction(tx);
    console.log('Simulation result:', simulation.value);

    if (simulation.value.err) {
      throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    console.log('User Account PublicKey:', response.data.userAccountPublicKey.toString());
    console.log('Associated Token Account:', response.data.associatedTokenAccount.toString());
    console.log('Transaction ID:', bs58.encode(tx.signatures[0]));
    console.log('Transaction:', base64Tx);

  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 