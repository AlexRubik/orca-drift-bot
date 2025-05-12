import { fork } from 'child_process';
import { GetInitUserInstructionsMessage } from './drift-worker.js';

// Create a child process
const worker = fork('./drift-worker.js.ts');

// Listen for messages from the worker
worker.on('message', (response) => {
  console.log('Received response:', response);
  worker.kill(); // Kill the worker after receiving response
});

const message: GetInitUserInstructionsMessage = {
  type: 'GET_INIT_USER_INSTRUCTIONS',
  data: {
    subAccountId: 0,
    name: 'RL Hedge Account'
  }
};

worker.send(message);