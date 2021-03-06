require('dotenv').config()
import http from 'http';
import https from 'https';
import Koa from 'koa';
import Io from 'socket.io';
import KoaBody from 'koa-body';
import cors from 'kcors';
import Router from 'koa-router';
import bluebird from 'bluebird';
import Redis from 'redis';
import socketRedis from 'socket.io-redis';
import Socket from './socket';
import crypto from 'crypto'
import mailer from './utils/mailer';
import koaStatic from 'koa-static';
import koaSend from 'koa-send';
import {pollForInactiveRooms} from './inactive_rooms';
import mongoose from 'mongoose'
import passport from 'koa-passport'
import jsonwebtoken from 'jsonwebtoken'
import passportStrategies from './passport'
import User from './mongoose'
import jwt from 'passport-jwt'

bluebird.promisifyAll(Redis.RedisClient.prototype);
bluebird.promisifyAll(Redis.Multi.prototype);

const redis = Redis.createClient(process.env.REDIS_URL)

export const getRedis = () => redis

const env = process.env.NODE_ENV || 'development';

mongoose.Promise = Promise
mongoose.connect(process.env.MONGO_URL)
mongoose.connection.on('error', console.error);


const app = new Koa();
const PORT = process.env.PORT || 3001;

const router = new Router();
const koaBody = new KoaBody();

const appName = process.env.HEROKU_APP_NAME;
const isReviewApp = /-pr-/.test(appName);
const siteURL = process.env.SITE_URL;

if ((siteURL || env === 'development') && !isReviewApp) {
  app.use(cors({
    origin: env === 'development' ? '*' : siteURL,
    allowMethods: ['GET','HEAD','POST'],
    credentials: true,
  }));
}

app.use(passport.initialize())
app.use(koaBody)

app.use(router.routes());

const apiHost = process.env.API_HOST;
const cspDefaultSrc = `'self'${apiHost ? ` https://${apiHost} wss://${apiHost}` : ''}`

function setStaticFileHeaders(ctx) {
  ctx.set({
    'strict-transport-security': 'max-age=31536000',
    'Content-Security-Policy': `default-src ${cspDefaultSrc} 'unsafe-inline'; img-src 'self' data:;`,
    'X-Frame-Options': 'deny',
    'X-XSS-Protection': '1; mode=block',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Feature-Policy': "geolocation 'none'; vr 'none'; payment 'none'; microphone 'none'",
  });
}

const clientDistDirectory = process.env.CLIENT_DIST_DIRECTORY;
if (clientDistDirectory) {
  app.use(async (ctx, next) => {
    setStaticFileHeaders(ctx);
    await koaStatic(clientDistDirectory, {
      maxage: ctx.req.url === '/' ? 60 * 1000 : 365 * 24 * 60 * 60 * 1000 // one minute in ms for html doc, one year for css, js, etc
    })(ctx, next);
  });

  app.use(async (ctx) => {
    setStaticFileHeaders(ctx);
    await koaSend(ctx, 'index.html', { root: clientDistDirectory });
  })
} else {
  app.use(async ctx => {
    ctx.body = { ready: true };
  });
}

const protocol = (process.env.PROTOCOL || 'http') === 'http' ? http : https;

const server = protocol.createServer(app.callback());
const io = Io(server, {
  pingInterval: 20000,
  pingTimeout: 5000
});
io.adapter(socketRedis(process.env.REDIS_URL));

const roomHashSecret = process.env.ROOM_HASH_SECRET;

const getRoomIdHash = (id) => {
  if (env === 'development') {
    return id
  }

  if (roomHashSecret) {
    return crypto
      .createHmac('sha256', roomHashSecret)
      .update(id)
      .digest('hex')
  }

  return crypto.createHash('sha256').update(id).digest('hex');
}

export const getIO = () => io

io.on('connection', async (socket) => {
  const roomId = socket.handshake.query.roomId

  const roomIdHash = getRoomIdHash(roomId)
  console.log("room is: ", roomId);

  let room = await redis.hgetAsync('rooms', roomIdHash)
  room = JSON.parse(room || '{}')

  new Socket({
    roomIdOriginal: roomId,
    roomId: roomIdHash,
    socket,
    room,
  })
})

let activeRooms = () => {
        var activeRooms = [];
        Object.keys(io.sockets.adapter.rooms).forEach(room=>{
            var isRoom = true;
            Object.keys(io.sockets.adapter.sids).forEach(id=>{
                isRoom = (id === room)? false: isRoom;
            });
            //NOT MORE THAN 2 PEOPLE IN ONE ROOM
            if (isRoom && io.sockets.adapter.rooms[room]["length"] === 1) {
              console.log(io.sockets.adapter.rooms[room]);
              activeRooms.push(room);
            }
        });
        return activeRooms;
      }

router.get('/active', (ctx) => {
  ctx.body = activeRooms();
})

router.post('/api/v1/login', async(ctx, next) => {
  await passport.authenticate('local', function (err, user) {
    if (user == false) {
      console.log(ctx.request.body);
      ctx.body = "Login failed";
    } else {
      //--payload - info to put in the JWT
      const payload = {
        id: user.id,
        displayName: user.displayName,
        email: user.email
      };
      const token = jsonwebtoken.sign(payload, process.env.JWT_SECRET, { expiresIn: '3h' }); //JWT is created here

      ctx.body = {user: user.displayName, token: 'JWT ' + token};
    }
  })(ctx, next);

});


router.post('/api/v1/signup', async(ctx, next) => {
  console.log(ctx.request.body);
  try {
    ctx.body = await User.create(ctx.request.body);
  }
  catch (err) {
    console.log(err);
    ctx.status = 400;
    ctx.body = err;
  }
});


router.get('/api/v1/guard_test', async(ctx, next) => {

  await passport.authenticate('jwt', function (err, user) {
    if (user) {
      ctx.body = {name: user.displayName};
    } else {
      ctx.body = "No such user";
      console.log("err", err)
    }
  } )(ctx, next)

});


const init = async () => {
  server.listen(PORT, () => {
    console.log(`Druwire is online at port ${PORT}`);
  })

  pollForInactiveRooms();
}

init()
