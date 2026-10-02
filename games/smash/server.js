import { createExchangeServer } from '../../exchange/index.js';
import { smash } from './game.js';

createExchangeServer(smash).listen();
