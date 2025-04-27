import { createServer } from '@vercel/node';
import app from '../src/index'; // this must export your Express app

export default createServer(app);
