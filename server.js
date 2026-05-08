// ═══════════════════════════════════════════════
// GODZILLA DOWNTREND — Full Stack Server
// Express web server + Trading bot + Dashboard WS
// ═══════════════════════════════════════════════
'use strict';

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const fetch      = require('node-fetch');
const path       = require('path');

const app        = express();
const server     = http.createServer(app);

// Dashboard WebSocket server (browser connects here)
const dashWss    = new WebSocket.Server({ server, path: '/dashboard' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ── STATE ────────────────────────────────────────
let cfg = {
  apiToken:         process.env.DERIV_TOKEN    || '',
  market:           process.env.MARKET         || '1HZ100V',
  command:          process.env.COMMAND        || 'NOTOUCH',
  stake:            parseFloat(process.env.STAKE       || '1.00'),
  durationMins:     parseInt(process.env.DURATION      || '2'),
  barrierOffset:    process.env.BARRIER        || '+2.1',
  multiplier:       parseInt(process.env.MULTIPLIER    || '10'),
  takeProfit:       parseFloat(process.env.TP          || '4.00'),
  stopLoss:         parseFloat(process.env.SL          || '2.00'),
  scanTF:           process.env.SCAN_TF        || 'M1+M5',
  minTFConfirm:     parseInt(process.env.MIN_TF        || '2'),
  smallTol:         parseInt(process.env.SMALL_TOL     || '10'),
  bigTol:           parseInt(process.env.BIG_TOL       || '15'),
  smallConfirm:     parseInt(process.env.SMALL_CONFIRM || '1'),
  bigConfirm:       parseInt(process.env.BIG_CONFIRM   || '2'),
  proximityPct:     parseFloat(process.env.PROXIMITY   || '90'),
  maxTrades:        parseInt(process.env.MAX_TRADES     || '0'),
  maxConsecLosses:  parseInt(process.env.MAX_LOSSES     || '2'),
  cooldownSecs:     parseInt(process.env.COOLDOWN       || '1800'),
  teleToken:        process.env.TELE_TOKEN     || '',
  teleChatId:       process.env.TELE_CHAT_ID   || '',
};

const APP_ID = 1089;

let derivWs           = null;
let botActive         = false;
let currentPrice      = 0;
let candles           = { M1: [], M5: [], M15: [] };
let trendStatus       = { M1: null, M5: null, M15: null };
let confirmedTrend    = false;

let resistanceLevels  = [];
let projectedLevel    = null;
let activeSmallStruct = null;
let activeBigStruct   = null;
let currentStructType = null;
let currentActiveLevel = null;
let globalTradedLevels = new Set();

let inTrade           = false;
let currentContractId = null;
let pricePassed       = false;
let passedCandleCount = 0;

let tradeCount = 0, wins = 0, losses = 0, sessionPnl = 0;
let tradeLog   = []; // last 50 trades

let consecutiveLosses    = 0;
let lossCountdownPaused  = false;
let lossCountdownTimer   = null;
let lossCountdownRemaining = 0;
let lossCountdownTotal   = 0;

let scanInterval    = null;
let reconnectTimer  = null;
let tickerMsg       = '— GODZILLA READY —';
let statusText      = 'IDLE';

// ── LOGGING ──────────────────────────────────────
function log(msg) {
  const t = new Date().toISOString().replace('T',' ').slice(0,19);
  console.log(`[${t}] ${msg}`);
  broadcastDash({ type: 'log', msg: `[${t}] ${msg}` });
}

// ── BROADCAST TO DASHBOARD ───────────────────────
function broadcastDash(data) {
  const json = JSON.stringify(data);
  dashWss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

function broadcastState() {
  broadcastDash({
    type: 'state',
    botActive,
    currentPrice,
    trendStatus,
    confirmedTrend,
    resistanceLevels,
    projectedLevel,
    currentStructType,
    currentActiveLevel,
    tradeCount, wins, losses, sessionPnl,
    consecutiveLosses,
    lossCountdownPaused,
    lossCountdownRemaining,
    lossCountdownTotal,
    pricePassed, passedCandleCount,
    tickerMsg, statusText,
    cfg,
    tradeLog: tradeLog.slice(0, 20),
  });
}

function setTicker(msg) {
  tickerMsg = msg;
  broadcastDash({ type: 'ticker', msg });
}

function setStatus(s, t) {
  statusText = t;
  broadcastDash({ type: 'status', status: s, text: t });
}

// ── TELEGRAM ─────────────────────────────────────
async function telegram(msg) {
  if (!cfg.teleToken || !cfg.teleChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.teleToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.teleChatId, text: `🦎 GODZILLA DOWN\n${msg}`, parse_mode: 'HTML' })
    });
  } catch (e) { log('Telegram error: ' + e.message); }
}

// ── TREND ─────────────────────────────────────────
function analyzeTrend(tf) {
  const data = candles[tf];
  if (data.length < 10) return;
  const recent = data.slice(-20);
  const highs = recent.map(c => c.high);
  const lows  = recent.map(c => c.low);
  let lh=0,ll=0,hh=0,hl=0;
  for (let i=1;i<highs.length;i++){
    if(highs[i]<highs[i-1])lh++;else hh++;
    if(lows[i]<lows[i-1])ll++;else hl++;
  }
  const total = highs.length-1;
  const ds = (lh+ll)/(total*2);
  const us = (hh+hl)/(total*2);
  trendStatus[tf] = ds>=0.6?'down':us>=0.6?'up':'neutral';
  checkTrendConfirmation();
  broadcastDash({ type:'trend', trendStatus, confirmedTrend });
}

function checkTrendConfirmation() {
  const dc = Object.values(trendStatus).filter(t=>t==='down').length;
  const was = confirmedTrend;
  confirmedTrend = dc >= cfg.minTFConfirm;
  if (confirmedTrend && !was) {
    log(`✅ DOWNTREND confirmed (${dc}/3)`);
    telegram(`✅ Downtrend confirmed on ${dc}/3 timeframes`);
  }
}

// ── STRUCTURE DETECTION ──────────────────────────
function findStructuresInData(data) {
  if (data.length < 10) return { smallStruct:null, bigStruct:null };
  const LR=2, peaks=[];
  for (let i=LR;i<data.length-LR;i++){
    let top=true;
    for(let j=i-LR;j<=i+LR;j++){
      if(j!==i&&data[j].high>=data[i].high){top=false;break;}
    }
    if(top) peaks.push({price:data[i].high,index:i});
  }
  if(peaks.length<2) return {smallStruct:null,bigStruct:null};

  function findBestGroup(minSpan,maxSpan){
    let best=null;
    for(let s=0;s<peaks.length-1;s++){
      const sp0=peaks[s+1].index-peaks[s].index;
      if(sp0<minSpan||sp0>maxSpan) continue;
      if(peaks[s+1].price>=peaks[s].price) continue;
      const bd=peaks[s].price-peaks[s+1].price;
      if(bd<=0) continue;
      const grp=[peaks[s],peaks[s+1]];
      for(let j=s+2;j<peaks.length;j++){
        const prev=grp[grp.length-1];
        const sp=peaks[j].index-prev.index;
        if(sp<minSpan||sp>maxSpan) continue;
        if(peaks[j].price>=prev.price) continue;
        const diff=prev.price-peaks[j].price;
        if(Math.abs(diff-bd)/bd<=0.10) grp.push(peaks[j]);
      }
      if(grp.length>=2){
        const tol=maxSpan===5?cfg.smallTol:cfg.bigTol;
        const cs=data.length-1-grp[grp.length-1].index;
        if(cs>tol) continue;
        const lp=grp[grp.length-1].price;
        let broken=false;
        for(let k=grp[grp.length-1].index+1;k<data.length;k++){
          if(Math.max(data[k].open,data[k].close)>lp+0.05){broken=true;break;}
        }
        if(broken) continue;
        if(!best||grp.length>best.peaks.length) best={peaks:grp,baseDiff:bd};
      }
    }
    return best;
  }
  return { smallStruct:findBestGroup(2,5), bigStruct:findBestGroup(5,15) };
}

function findLevels() {
  const tfs = cfg.scanTF==='M1'?['M1']:cfg.scanTF==='M5'?['M5']:['M1','M5'];
  let bs=null,bb=null;
  for(const tf of tfs){
    const data=candles[tf];
    if(data.length<10) continue;
    const r=findStructuresInData(data);
    if(r.smallStruct&&!bs) bs={...r.smallStruct,tf};
    if(r.bigStruct&&!bb)   bb={...r.bigStruct,tf};
  }
  activeSmallStruct=bs; activeBigStruct=bb;
  const active=bs||bb;
  currentStructType=bs?'small':bb?'big':null;

  if(!active){
    if(resistanceLevels.length>0){
      log('⏳ Tolerance broken — scanning fresh...');
      resistanceLevels=[]; projectedLevel=null; currentActiveLevel=null;
      pricePassed=false; passedCandleCount=0; globalTradedLevels=new Set();
      broadcastState();
    }
    return;
  }

  const nl=active.peaks.map(p=>p.price);
  const ll=nl[nl.length-1];
  const fpc=resistanceLevels.length===0||Math.abs(resistanceLevels[0]-nl[0])>0.05;
  if(fpc){
    log(`📐 New ${currentStructType.toUpperCase()} structure — ${nl.length} peaks diff=${active.baseDiff.toFixed(2)}`);
    globalTradedLevels=new Set(); pricePassed=false; passedCandleCount=0;
  }
  resistanceLevels=nl;

  let np=parseFloat((ll-active.baseDiff).toFixed(2));
  let safety=0;
  while(globalTradedLevels.has(np.toFixed(2))&&safety<20){
    np=parseFloat((np-active.baseDiff).toFixed(2)); safety++;
  }
  if(!projectedLevel||Math.abs(np-projectedLevel)>0.01){
    projectedLevel=np; currentActiveLevel=np;
    pricePassed=false; passedCandleCount=0;
    log(`🎯 Target: ${projectedLevel.toFixed(2)} | ${currentStructType} | diff=${active.baseDiff.toFixed(2)}`);
  }
  broadcastState();
}

// ── ENTRY CHECK ──────────────────────────────────
function checkEntry() {
  if(!botActive||inTrade||!confirmedTrend) return;
  if(lossCountdownPaused) return;
  if(!projectedLevel) return;
  if(globalTradedLevels.has(projectedLevel.toFixed(2))) return;
  if(cfg.maxTrades>0&&tradeCount>=cfg.maxTrades){stopBot();return;}

  const target=projectedLevel;
  const pct=cfg.proximityPct/100;
  const bd=activeSmallStruct?.baseDiff||activeBigStruct?.baseDiff||5;
  const maxGap=bd*(1-pct);
  const confirmCount=currentStructType==='small'?cfg.smallConfirm:cfg.bigConfirm;
  const data=candles['M1'];
  if(data.length<3) return;

  if(!pricePassed){
    let count=0;
    for(let i=data.length-1;i>=Math.max(0,data.length-40);i--){
      if(Math.max(data[i].open,data[i].close)<target) count++;
      else break;
    }
    if(count>=confirmCount){
      pricePassed=true; passedCandleCount=count;
      setTicker(`✅ ${count} candles below ${target.toFixed(2)} — waiting pullback...`);
      telegram(`✅ ${count} candles below <b>${target.toFixed(2)}</b>\nPrice: ${currentPrice.toFixed(2)}`);
    } else {
      setTicker(`⏳ Need ${confirmCount} candles below ${target.toFixed(2)} (${count}/${confirmCount}) — ${currentPrice.toFixed(2)}`);
      return;
    }
  }

  if(currentPrice>=target){ pricePassed=false; passedCandleCount=0; setTicker(`⚠ Above ${target.toFixed(2)} — reset`); return; }
  if(currentPrice<target-maxGap){ setTicker(`📡 ${currentPrice.toFixed(2)} — waiting pullback to ${(target-maxGap).toFixed(2)}→${target.toFixed(2)}`); return; }

  const last=data[data.length-1], prev=data[data.length-2];
  if(last.close<=prev.close){ setTicker(`📡 In zone — waiting bullish close...`); return; }

  setTicker(`⚡ ENTRY! ${currentPrice.toFixed(2)} at level ${target.toFixed(2)}`);
  telegram(`⚡ <b>ENTRY</b>\nLevel: <b>${target.toFixed(2)}</b>\nPrice: ${currentPrice.toFixed(2)}\nCommand: ${cfg.command}\nStruct: ${currentStructType?.toUpperCase()}`);
  globalTradedLevels.add(target.toFixed(2));
  currentActiveLevel=target; pricePassed=false; passedCandleCount=0;
  placeTrade();
}

// ── PLACE TRADE ──────────────────────────────────
function placeTrade() {
  if(!derivWs||derivWs.readyState!==WebSocket.OPEN){inTrade=false;return;}
  inTrade=true;
  const duration=cfg.durationMins*60;
  const type={NOTOUCH:'NOTOUCH',TOUCH:'ONETOUCH',HIGHER:'CALL',LOWER:'PUT',RISE:'CALL',FALL:'PUT',CALL_MULT:'MULTUP',PUT_MULT:'MULTDOWN'}[cfg.command]||'NOTOUCH';

  if(cfg.command==='CALL_MULT'||cfg.command==='PUT_MULT'){
    derivWs.send(JSON.stringify({buy:1,price:cfg.stake,parameters:{contract_type:type,symbol:cfg.market,basis:'stake',amount:cfg.stake,currency:'USD',multiplier:cfg.multiplier}}));
    setTimeout(()=>{
      if(currentContractId&&derivWs?.readyState===WebSocket.OPEN)
        derivWs.send(JSON.stringify({proposal_open_contract:1,contract_id:currentContractId,subscribe:1}));
    },2000);
  } else {
    const params={contract_type:type,symbol:cfg.market,duration,duration_unit:'s',basis:'stake',amount:cfg.stake,currency:'USD'};
    if(['NOTOUCH','TOUCH','HIGHER','LOWER'].includes(cfg.command)) params.barrier=cfg.barrierOffset;
    derivWs.send(JSON.stringify({buy:1,price:cfg.stake,parameters:params}));
    setTimeout(()=>{
      if(currentContractId&&derivWs?.readyState===WebSocket.OPEN)
        derivWs.send(JSON.stringify({proposal_open_contract:1,contract_id:currentContractId}));
    },(duration+5)*1000);
  }
  broadcastState();
}

// ── LOSS CONTROL ─────────────────────────────────
function startLossCountdown(totalSecs) {
  stopLossCountdown();
  lossCountdownPaused=true; lossCountdownRemaining=totalSecs; lossCountdownTotal=totalSecs;
  const label=totalSecs===1800?'30 MIN':totalSecs===3600?'1 HR':'4 HR';
  log(`⏸ Cooldown: ${label}`);
  telegram(`⏸ <b>Paused after loss</b>\nCooldown: ${label}`);
  setStatus('scanning','PAUSED — COOLDOWN');
  lossCountdownTimer=setInterval(()=>{
    lossCountdownRemaining--;
    broadcastDash({type:'countdown',remaining:lossCountdownRemaining,total:lossCountdownTotal});
    if(lossCountdownRemaining<=0) resumeAfterCooldown();
  },1000);
}

function stopLossCountdown() {
  if(lossCountdownTimer){clearInterval(lossCountdownTimer);lossCountdownTimer=null;}
}

function resumeAfterCooldown() {
  lossCountdownPaused=false; stopLossCountdown();
  log('✅ Cooldown done — resuming');
  telegram('✅ Cooldown done — resuming trades');
  setStatus('running','RUNNING');
  setTicker('✅ Cooldown done — scanning...');
  broadcastState();
  if(botActive) findLevels();
}

// ── RESULT ───────────────────────────────────────
function finalizeResult(profit) {
  if(!inTrade) return;
  inTrade=false; tradeCount++; sessionPnl+=profit;
  const won=profit>0;
  if(won) wins++; else losses++;
  const wr=Math.round((wins/tradeCount)*100);

  const card={id:tradeCount,time:new Date().toLocaleTimeString(),won,profit,level:currentActiveLevel?.toFixed(2),struct:currentStructType,command:cfg.command,market:cfg.market,stake:cfg.stake,wr};
  tradeLog.unshift(card);
  if(tradeLog.length>50) tradeLog.pop();

  log(`${won?'✅ WIN':'❌ LOSS'} #${tradeCount} | ${profit>=0?'+':''}$${profit.toFixed(2)} | P&L: ${sessionPnl>=0?'+':''}$${sessionPnl.toFixed(2)} | WR: ${wr}%`);
  telegram(`${won?'✅ WIN':'❌ LOSS'} #${tradeCount}\nProfit: <b>${profit>=0?'+':''}$${profit.toFixed(2)}</b>\nP&amp;L: ${sessionPnl>=0?'+':''}$${sessionPnl.toFixed(2)}\nWR: ${wr}%\nLevel: ${currentActiveLevel?.toFixed(2)}`);

  currentContractId=null;
  broadcastDash({type:'trade',card});
  broadcastState();

  if(won){
    consecutiveLosses=0;
    setTicker(`✅ WIN +$${profit.toFixed(2)} — scanning...`);
    setTimeout(()=>{if(botActive)findLevels();},1000);
  } else {
    consecutiveLosses++;
    if(consecutiveLosses>=cfg.maxConsecLosses){
      botActive=false; lossCountdownPaused=false; stopLossCountdown(); stopScanner();
      setStatus('stopped',`STOPPED — ${cfg.maxConsecLosses} LOSSES`);
      setTicker(`🛑 ${cfg.maxConsecLosses} consecutive losses — restart manually`);
      log(`🛑 Bot stopped after ${cfg.maxConsecLosses} consecutive losses`);
      telegram(`🛑 <b>Bot stopped</b>\n${cfg.maxConsecLosses} consecutive losses\nRestart from dashboard`);
      broadcastState();
    } else {
      setTicker(`❌ LOSS — starting cooldown...`);
      startLossCountdown(cfg.cooldownSecs);
    }
  }
}

// ── WEBSOCKET TO DERIV ────────────────────────────
function connectDeriv() {
  if(derivWs){try{derivWs.terminate();}catch(e){}}
  const url=`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`;
  log(`🔌 Connecting to Deriv...`);
  setStatus('connecting','CONNECTING');
  derivWs=new WebSocket(url);

  derivWs.on('open',()=>{
    log('🔗 Connected — authorizing...');
    derivWs.send(JSON.stringify({authorize:cfg.apiToken}));
  });

  derivWs.on('message',(raw)=>{
    let d; try{d=JSON.parse(raw);}catch(e){return;}

    if(d.msg_type==='authorize'){
      if(d.error){log('❌ Auth: '+d.error.message);setStatus('stopped','AUTH FAILED');broadcastState();return;}
      log(`✅ Auth: ${d.authorize.loginid} | $${d.authorize.balance}`);
      telegram(`🟢 <b>Bot started</b>\nAccount: ${d.authorize.loginid}\nBalance: $${d.authorize.balance}\nMarket: ${cfg.market} | ${cfg.command} | $${cfg.stake}`);
      botActive=true;
      setStatus('running','RUNNING');
      derivWs.send(JSON.stringify({ticks:cfg.market,subscribe:1}));
      fetchCandles('M1'); fetchCandles('M5'); fetchCandles('M15');
      startScanner();
      broadcastState();
    }

    if(d.msg_type==='tick'){
      currentPrice=parseFloat(d.tick.quote);
      broadcastDash({type:'price',price:currentPrice});
      if(botActive&&!inTrade) checkEntry();
    }

    if(d.msg_type==='candles'){
      const gran=d.echo_req.granularity;
      const tf=gran===60?'M1':gran===300?'M5':'M15';
      candles[tf]=d.candles.map(c=>({time:c.epoch,open:parseFloat(c.open),high:parseFloat(c.high),low:parseFloat(c.low),close:parseFloat(c.close)}));
      log(`📊 ${tf}: ${candles[tf].length} candles`);
      analyzeTrend(tf);
      broadcastDash({type:'candles',tf,candles:candles[tf].slice(-100)});
    }

    if(d.msg_type==='ohlc'){
      const gran=d.ohlc.granularity;
      const tf=gran===60?'M1':gran===300?'M5':'M15';
      const c={time:d.ohlc.open_time,open:parseFloat(d.ohlc.open),high:parseFloat(d.ohlc.high),low:parseFloat(d.ohlc.low),close:parseFloat(d.ohlc.close)};
      if(candles[tf].length&&candles[tf][candles[tf].length-1].time===c.time) candles[tf][candles[tf].length-1]=c;
      else{candles[tf].push(c);if(candles[tf].length>300)candles[tf].shift();}
      analyzeTrend(tf);
      broadcastDash({type:'candle_update',tf,candle:c});
    }

    if(d.msg_type==='buy'){
      if(d.error){log('❌ '+d.error.message);inTrade=false;telegram(`❌ ${d.error.message}`);broadcastState();return;}
      currentContractId=d.buy.contract_id;
      log(`📝 Contract: ${currentContractId}`);
    }

    if(d.msg_type==='proposal_open_contract'){
      const con=d.proposal_open_contract; if(!con) return;
      const profit=parseFloat(con.profit)||0;
      if(cfg.command==='CALL_MULT'||cfg.command==='PUT_MULT'){
        if(profit>=cfg.takeProfit||profit<=-cfg.stopLoss)
          derivWs.send(JSON.stringify({sell:currentContractId,price:0}));
      }
      if(con.status==='sold'||con.is_expired||con.is_settleable) finalizeResult(profit);
    }

    if(d.msg_type==='sell'){
      if(d.sell) finalizeResult(parseFloat(d.sell.sold_for)-cfg.stake);
    }
  });

  derivWs.on('close',()=>{
    log('Disconnected');
    botActive=false; stopScanner();
    setStatus('stopped','DISCONNECTED');
    broadcastState();
    // Do NOT auto-reconnect — user must press Start button manually
  });

  derivWs.on('error',(e)=>log('WS error: '+e.message));
}

function fetchCandles(tf) {
  if(!derivWs||derivWs.readyState!==WebSocket.OPEN) return;
  const gran=tf==='M1'?60:tf==='M5'?300:900;
  derivWs.send(JSON.stringify({ticks_history:cfg.market,adjust_start_time:1,count:200,end:'latest',granularity:gran,start:1,style:'candles',subscribe:1}));
}

function startScanner() {
  if(scanInterval) clearInterval(scanInterval);
  findLevels();
  scanInterval=setInterval(()=>{if(botActive&&!inTrade&&!lossCountdownPaused)findLevels();},1000);
}

function stopScanner() {
  if(scanInterval){clearInterval(scanInterval);scanInterval=null;}
}

function stopBot() {
  botActive=false; stopScanner(); stopLossCountdown();
  if(derivWs){try{derivWs.close();}catch(e){}}
  setStatus('stopped','STOPPED');
  setTicker('— GODZILLA STOPPED —');
  const wr=tradeCount>0?Math.round((wins/tradeCount)*100):0;
  telegram(`⏹ Session ended\nTrades: ${tradeCount} | WR: ${wr}%\nP&amp;L: ${sessionPnl>=0?'+':''}$${sessionPnl.toFixed(2)}`);
  broadcastState();
}

// ── DASHBOARD WEBSOCKET ───────────────────────────
dashWss.on('connection',(ws)=>{
  log('📱 Dashboard connected');
  // Send full state on connect
  ws.send(JSON.stringify({type:'state',...getFullState()}));
  // Send candle data
  ['M1','M5','M15'].forEach(tf=>{
    if(candles[tf].length) ws.send(JSON.stringify({type:'candles',tf,candles:candles[tf].slice(-100)}));
  });

  ws.on('message',(raw)=>{
    let msg; try{msg=JSON.parse(raw);}catch(e){return;}

    if(msg.type==='start'){
      if(msg.cfg) cfg={...cfg,...msg.cfg};
      if(!cfg.apiToken){ws.send(JSON.stringify({type:'error',msg:'No API token'}));return;}
      // Reset session stats
      tradeCount=0;wins=0;losses=0;sessionPnl=0;tradeLog=[];
      consecutiveLosses=0;lossCountdownPaused=false;
      connectDeriv();
    }

    if(msg.type==='stop') stopBot();

    if(msg.type==='skip_cooldown'){
      if(lossCountdownPaused) resumeAfterCooldown();
    }

    if(msg.type==='update_cfg'){
      cfg={...cfg,...msg.cfg};
      log('⚙ Settings updated: '+JSON.stringify(msg.cfg));
    }

    if(msg.type==='get_state') ws.send(JSON.stringify({type:'state',...getFullState()}));
  });

  ws.on('close',()=>log('📱 Dashboard disconnected'));
});

function getFullState() {
  return {
    botActive,currentPrice,trendStatus,confirmedTrend,
    resistanceLevels,projectedLevel,currentStructType,currentActiveLevel,
    tradeCount,wins,losses,sessionPnl,consecutiveLosses,
    lossCountdownPaused,lossCountdownRemaining,lossCountdownTotal,
    pricePassed,passedCandleCount,tickerMsg,statusText,cfg,
    tradeLog:tradeLog.slice(0,20),
  };
}

// ── REST API ──────────────────────────────────────
app.get('/ping', (req,res)=>res.send('OK')); // UptimeRobot keep-alive endpoint
app.get('/api/state', (req,res)=>res.json(getFullState()));
app.post('/api/start',(req,res)=>{
  if(req.body.cfg) cfg={...cfg,...req.body.cfg};
  tradeCount=0;wins=0;losses=0;sessionPnl=0;tradeLog=[];
  consecutiveLosses=0;lossCountdownPaused=false;
  connectDeriv();
  res.json({ok:true});
});
app.post('/api/stop',(req,res)=>{stopBot();res.json({ok:true});});
app.post('/api/cfg',(req,res)=>{cfg={...cfg,...req.body};log('Config updated');res.json({ok:true,cfg});});
app.post('/api/skip_cooldown',(req,res)=>{if(lossCountdownPaused)resumeAfterCooldown();res.json({ok:true});});

// Status every 5 minutes
setInterval(()=>{
  if(!botActive) return;
  const wr=tradeCount>0?Math.round((wins/tradeCount)*100):0;
  log(`📊 Price:${currentPrice.toFixed(2)} Trades:${tradeCount} WR:${wr}% P&L:${sessionPnl>=0?'+':''}$${sessionPnl.toFixed(2)} Target:${projectedLevel?.toFixed(2)||'--'} Trend:${confirmedTrend?'DOWN✅':'waiting'}`);
},5*60*1000);

server.listen(PORT,()=>{
  log(`🦎 GODZILLA SERVER running on port ${PORT}`);
  log(`📱 Dashboard: http://localhost:${PORT}`);
});

process.on('SIGINT',()=>{stopBot();setTimeout(()=>process.exit(0),1000);});
process.on('SIGTERM',()=>{stopBot();setTimeout(()=>process.exit(0),1000);});
