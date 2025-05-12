import { getInitUserInstructions } from './worker-api.js';

async function main() {
  try {
    const response = await getInitUserInstructions(0, 'Test Account');
    console.log('Init user instructions:', response.data); // Promise<TransactionInstruction[]>
  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 