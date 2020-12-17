import { NotFoundError, ApiError, InternalError } from './core/api-error';
import express, { Request, Response, NextFunction } from 'express';
import { corsUrl, environment } from './config';
import { ServiceAccount } from 'firebase-admin';
import Server, { Socket } from 'socket.io';
import * as admin from 'firebase-admin';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import Logger from './core/logger';
import { History, Question } from './types';
import cors from 'cors';
import * as got from 'got';

process.on('uncaughtException', (e) => {
  Logger.error(e.message);
});

const app = express();

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true, parameterLimit: 50000 }));
app.use(cors({ origin: corsUrl, optionsSuccessStatus: 200 }));
app.use(express.static('public'));

// Initialize firebase
const adminConfig: ServiceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};
admin.initializeApp({
  credential: admin.credential.cert(adminConfig),
  databaseURL: 'https://bidding-portal.firebaseio.com',
});
const docRef = admin.firestore().collection('bidding').doc('details');

// Initialize sockets
const httpServer = createServer(app);
const io = new Server(httpServer, {
  transports: ['websocket', 'polling'],
  allowUpgrades: false,
  pingTimeout: 6000000,
  pingInterval: 30000,
});

let currentBid = 0;
let history: Array<History> = [];
let currQuestion = '';
let roundDetails;
let questions: Array<Question> = [];
let minBid = 0;

(async () => {
  roundDetails = await got.get('https://bidding-portal.appspot.com/api/bidding', {
    json: true,
  });
  questions = roundDetails.body.questions;
  currentBid = roundDetails.body.minBid;
  currQuestion = roundDetails.body.questions[0].id;
})();

const changeQuestion = (socket: Socket, id: string) => {
  const response = questions.filter((item: Question) => item.id === id);
  if (response.length === 0) {
    Logger.error('Incorrect questionID supplied');
    socket.emit('message', 'Incorrect questionID supplied');
  } else {
    history = [];
    currentBid = minBid;
    currQuestion = id;
    io.emit('history', { error: false, history: [] });
  }
};

io.on('connection', async (socket: Socket) => {
  Logger.info(`${socket.id} connected`);

  docRef.onSnapshot((doc) => {
    socket.emit('message', `Welcome to ${doc.data()?.name}`);
    io.emit('minimum', doc.data()?.minBid);
    io.emit('history', { error: false, history: history });
    minBid = doc.data()?.minBid;
  });

  socket.on('bid', (data) => {
    if (data.questionID !== currQuestion) changeQuestion(socket, data.questionID);
    if (data.bid > currentBid) {
      currentBid = data.bid;
      Logger.info(`${socket.id} made a bid of ${data.bid} (current bid: ${currentBid})`);

      // Push to history
      history.push({ id: socket.id, bid: data.bid });
      io.emit('history', { error: false, history });
    } else {
      Logger.info(`${socket.id} made a bid too small`);
      socket.emit('history', { error: true, history });
    }
  });

  socket.on('disconnect', () => {
    Logger.info(`${socket.id} disconnected`);
  });
});

// Catch 404 and forward to error handler
app.use((_req, _res, next) => next(new NotFoundError()));

// Middleware Error Handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    ApiError.handle(err, res);
  } else {
    if (environment === 'development') {
      Logger.error(err);
      return res.status(500).send(err.message);
    }
    ApiError.handle(new InternalError(), res);
  }
});

export default httpServer;
