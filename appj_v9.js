const blessed = require("blessed");
const contrib = require("blessed-contrib");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

process.env.LANG = "en_GB.UTF-8";
process.env.LC_ALL = "en_GB.UTF-8";
process.env.TERM = "xterm-256color";

const DOWNLOAD_DIR = "./mp3";
const HISTORY_FILE = "./history.json";

const CONCURRENCY = 2;
const SAFE_LIMIT = 1;

let queue = [];
let retryQueue = [];
let seen = new Set();
let history = new Set();

let index = 0;
let active = 0;
let done = 0;
let failed = 0;

let dynamicDelay = 300;
let globalCooldown = 0;

let startTime = Date.now();
let systemState = "INIT";

//////////////////////////////
// INIT
//////////////////////////////

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

if (fs.existsSync(HISTORY_FILE)) {
  try {
    history = new Set(JSON.parse(fs.readFileSync(HISTORY_FILE)));
  } catch {}
}

function saveHistory(){
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([...history]));
}

//////////////////////////////
// UTIL
//////////////////////////////

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function countMP3(){
  return fs.readdirSync(DOWNLOAD_DIR).filter(f=>f.endsWith(".mp3")).length;
}

function folderSizeMB(){
  let total = 0;
  for(const f of fs.readdirSync(DOWNLOAD_DIR)){
    try{
      total += fs.statSync(path.join(DOWNLOAD_DIR,f)).size;
    }catch{}
  }
  return (total/1024/1024).toFixed(1);
}

function cleanupTemp(){
  for(const f of fs.readdirSync(DOWNLOAD_DIR)){
    if(f.endsWith(".mp4") || f.endsWith(".webm") || f.endsWith(".m4a")){
      try{
        fs.unlinkSync(path.join(DOWNLOAD_DIR,f));
        log("INFO",`Deleted temp: ${f}`);
      }catch{}
    }
  }
}

function uptime(){
  return Math.floor((Date.now() - startTime)/1000);
}

//////////////////////////////
// UI (REBALANCED)
//////////////////////////////

const screen = blessed.screen({
  smartCSR: true,
  title: "YT GRID PRO MAX",
  terminal: "xterm-256color"
});

const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// 🔥 SYSTEM (narrow)
const statsBox = grid.set(0, 0, 3, 4, blessed.box, {
  label: "SYSTEM",
  border: "line"
});

// 🔥 DOWNLOAD (wide)
const downloadBox = grid.set(0, 4, 3, 8, blessed.log, {
  label: "DOWNLOAD",
  border: "line",
  scrollable: true
});

// 🔥 WORKERS (narrow)
const workerTable = grid.set(3, 0, 4, 4, contrib.table, {
  label: "WORKERS",
  columnWidth: [6, 10, 10]
});

// 🔥 CONVERT (wide)
const convertBox = grid.set(3, 4, 4, 8, blessed.log, {
  label: "CONVERT",
  border: "line",
  scrollable: true
});

// 🔥 LOGS (full width, biggest)
const logBox = grid.set(7, 0, 5, 12, blessed.log, {
  label: "LOGS",
  border: "line",
  scrollable: true
});

screen.key(['q','C-c'],()=>process.exit(0));

//////////////////////////////
// LOG
//////////////////////////////

function log(type,msg){
  logBox.log(`[${type}] ${msg}`);
}

//////////////////////////////
// SEARCH
//////////////////////////////

const searchTerms = [
  "gospel worship playlist",
  "christian worship mix"
];

function search(q){
  log("INFO",`Searching: ${q}`);

  return new Promise((resolve)=>{
    const yt = spawn("yt-dlp",[
      "--flat-playlist","-J",
      `ytsearch2:${q}`
    ]);

    let out="";

    yt.stdout.on("data",d=>out+=d.toString());

    yt.on("close",()=>{
      try{
        const json = JSON.parse(out);
        const urls = (json.entries||[]).map(e=>e.url);
        log("INFO",`Found ${urls.length}`);
        resolve(urls);
      }catch{
        log("ERRO","Search failed");
        resolve([]);
      }
    });
  });
}

//////////////////////////////
// DOWNLOAD
//////////////////////////////

function download(url,retry=0){

  if(history.has(url)){
    log("INFO","Skip (history)");
    return;
  }

  active++;
  log("INFO",`Start: ${url}`);

  const yt = spawn("yt-dlp",[
    "--geo-bypass",
    "--sleep-requests","2",
    "--user-agent","Mozilla/5.0",
    "-f","bestaudio",
    "--extract-audio",
    "--audio-format","mp3",
    "--newline",
    "--paths", DOWNLOAD_DIR,
    url
  ]);

  yt.stdout.on("data",d=>{
    const s = d.toString();

    if(s.includes("[download]")) downloadBox.log(s.trim());
    if(s.includes("ETA") || s.includes("KiB/s")) downloadBox.log(s.trim());
    if(s.includes("ExtractAudio") || s.includes("ffmpeg")) convertBox.log(s.trim());
  });

  yt.stderr.on("data",d=>{
    const s = d.toString();

    if(s.includes("Sign in to confirm")){
      log("WARN","Bot detected → retry");

      if(retry < 3){
        retryQueue.push(url);
      }

      dynamicDelay = Math.min(dynamicDelay+200,2000);
      globalCooldown = Date.now()+10000;

      yt.kill();
    }

    if(s.toLowerCase().includes("error")){
      log("ERRO",s.trim());
    }
  });

  yt.on("close",(code)=>{

    active--;

    if(code === 0){
      done++;
      history.add(url);
      saveHistory();

      log("INFO","DONE");
      cleanupTemp();

      dynamicDelay = Math.max(200, dynamicDelay-50);

    } else {
      failed++;
      log("ERRO","FAILED");

      if(retry < 2){
        retryQueue.push(url);
      }
    }
  });
}

//////////////////////////////
// POOL
//////////////////////////////

async function runPool(){

  await sleep(2000);

  while(true){

    if(index >= queue.length && retryQueue.length === 0) return;

    if(Date.now() < globalCooldown){
      log("WARN","Cooling down...");
      await sleep(1000);
      continue;
    }

    let url = retryQueue.length ? retryQueue.shift() : queue[index++];

    if(seen.has(url)) continue;
    seen.add(url);

    while(active >= SAFE_LIMIT){
      await sleep(200);
    }

    download(url);

    await sleep(dynamicDelay);
  }
}

//////////////////////////////
// UI LOOP
//////////////////////////////

setInterval(()=>{

  statsBox.setContent(
`State: ${systemState}
Active: ${active}/${CONCURRENCY}
Queue: ${queue.length-index}
Retry: ${retryQueue.length}
Done: ${done}
Failed: ${failed}
Delay: ${dynamicDelay}ms
Files: ${countMP3()}
Disk: ${folderSizeMB()}MB
Up: ${uptime()}s`
  );

  workerTable.setData({
    headers:["W","State","Status"],
    data:[
      ["W1", active>0?"ACTIVE":"IDLE","RUN"],
      ["W2", active>1?"ACTIVE":"IDLE","RUN"]
    ]
  });

  screen.render();

},500);

//////////////////////////////
// MAIN
//////////////////////////////

async function main(){

  systemState = "SEARCHING";

  for(const t of searchTerms){
    const r = await search(t);
    queue.push(...r);
  }

  systemState = "DOWNLOADING";

  await runPool();
}

main();
