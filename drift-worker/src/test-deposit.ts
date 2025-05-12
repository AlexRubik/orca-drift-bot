import { getDepositInstruction } from './worker-api.js';

async function main() {
  try {
    const response = await getDepositInstruction(0, 100);
    console.log('Deposit instructions:', response.data); // Promise<[PublicKey, TransactionInstruction]>
  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 