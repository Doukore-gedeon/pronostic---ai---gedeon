function clamp(x,min=0,max=1){return Math.max(min,Math.min(max,Number(x)||0));}
function cornerSignal(hf,af){ const n=Math.min(Number(hf?.cornerN)||0,Number(af?.cornerN)||0); if(n<5) return {score:null,level:"INSUFFISANT",projection:null,over85:null,cornerN:n}; const projection=Number(hf.corners)+Number(af.corners); let p8=0; let t8=Math.exp(-projection); for(let k=0;k<=8;k++){ if(k>0)t8*=projection/k; p8+=t8; } const over85=clamp(1-p8); const consistency=Math.min(1,n/10); const score=Math.round((over85*70+consistency*30)); const level=score>=80?"TRÈS PROBABLE":score>=70?"PROBABLE":score>=55?"INCERTAIN":"PEU PROBABLE"; return {score,level,projection,over85,cornerN:n}; }
function getApiPrediction(pred){ if(!pred) return null; const p=pred.predictions||pred; const n=v=>{ const x=Number(v); return Number.isFinite(x)?x:null; }; return {winner:p.winner?.name||null, advice:p.advice||null, underOver:p.under_over||null, goalsHome:n(p.goals?.home), goalsAway:n(p.goals?.away), percent:p.percent||null}; }
function weightedMean(a){ if(!Array.isArray(a)||!a.length)return null; let s=0,w=0; for(let i=0;i<a.length;i++){let x=Number(a[i]);if(Number.isFinite(x)){let q=i+1;s+=x*q;w+=q;}} return w?s/w:null; }
function resultFor(f,id){ if(!f?.teams?.home || !f?.teams?.away || f?.goals?.home==null || f?.goals?.away==null) return null; const home=f.teams.home.id===id; const my=home?f.goals.home:f.goals.away; const opp=home?f.goals.away:f.goals.home; return my>opp?"W":my===opp?"D":"L"; }
function finished(f){ return f?.fixture?.status?.short==="FT" || f?.fixture?.status?.short==="AET" || f?.fixture?.status?.short==="PEN"; }
function mean(arr){ const a=(arr||[]).filter(x=>Number.isFinite(x)); return a.length?a.reduce((s,x)=>s+x,0)/a.length:null; } function historyFreshness(fixtures){ const dates=(fixtures||[]).map(f=>new Date(f?.fixture?.date)).filter(d=>Number.isFinite(d.getTime())).sort((a,b)=>b-a); if(!dates.length)return {latestDate:null,ageDays:null,fresh:false}; const ageDays=Math.floor((Date.now()-dates[0].getTime())/86400000); return {latestDate:dates[0].toISOString(),ageDays,fresh:ageDays<=540}; }
async function enrichRecent(fixtures){
  return (fixtures||[]).map(f=>{
    const home=f.teams?.home;
    const away=f.teams?.away;
    const gh=f.goals?.home;
    const ga=f.goals?.away;

    return {
      ...f,
      _enriched:{
        homeName:home?.name||"",
        awayName:away?.name||"",
        goalsHome:gh,
        goalsAway:ga,
        totalGoals:(gh==null||ga==null)?null:gh+ga,
        btts:(gh==null||ga==null)?null:(gh>0&&ga>0),
        over25:(gh==null||ga==null)?null:(gh+ga>=3)
      }
    };
  });
}
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";
const MODEL_VERSION = "V7.3";
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();
let apiCalls = 0;
let apiQuotaExhausted = false;
let apiWindowStarted = Date.now();
const API_QUOTA_FILE = path.join(__dirname, ".api_quota.json");
let lastSettlementAt = 0;
if (fs.existsSync(API_QUOTA_FILE)) {
  try {
    const savedQuota = JSON.parse(fs.readFileSync(API_QUOTA_FILE, "utf8"));
    if (savedQuota.exhaustedAt) {
      const elapsed = Date.now() - Number(savedQuota.exhaustedAt);
      if (elapsed < 86400000) {
        apiQuotaExhausted = true;
        apiWindowStarted = Number(savedQuota.exhaustedAt);
      } else {
        fs.unlinkSync(API_QUOTA_FILE);
        apiQuotaExhausted = false;
        apiWindowStarted = Date.now();
      }
    }
  } catch (_) {}
}

if (!API_KEY) console.warn("⚠️ API_FOOTBALL_KEY n'est pas défini.");

const db = new DatabaseSync(path.join(__dirname, "predictions.sqlite"));
function localFixtureById(id){ const r=db.prepare("SELECT fixture_id,kickoff,league,home_id,home,away_id,away,status,goals_home,goals_away,corners_home,corners_away,league_logo,league_country,home_logo,away_logo FROM fixtures_cache WHERE fixture_id=? LIMIT 1").get(id); if(!r)return null; return {fixture:{id:r.fixture_id,date:r.kickoff,status:{short:r.status}},league:{name:r.league,logo:r.league_logo,country:r.league_country},teams:{home:{id:r.home_id,name:r.home,logo:r.home_logo},away:{id:r.away_id,name:r.away,logo:r.away_logo}},goals:{home:r.goals_home,away:r.goals_away},statistics:[{team:{id:r.home_id},statistics:[{type:"Corner Kicks",value:r.corners_home}]},{team:{id:r.away_id},statistics:[{type:"Corner Kicks",value:r.corners_away}]}]}; }
function localDataAvailability(homeId,awayId,fixtureId){ const match=db.prepare("SELECT fixture_id FROM fixtures_cache WHERE fixture_id=? LIMIT 1").get(fixtureId); const home=db.prepare("SELECT COUNT(*) AS n FROM fixtures_cache WHERE source IN ('observed','h2h') AND status IN ('FT','AET','PEN') AND (home_id=? OR away_id=?) AND fixture_id!=?").get(homeId,homeId,fixtureId); const away=db.prepare("SELECT COUNT(*) AS n FROM fixtures_cache WHERE source='observed' AND status IN ('FT','AET','PEN') AND (home_id=? OR away_id=?) AND fixture_id!=?").get(awayId,awayId,fixtureId); return {usable:!!match && Number(home?.n||0)>=6 && Number(away?.n||0)>=6,home:Number(home?.n||0),away:Number(away?.n||0)}; }
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fixture_id INTEGER NOT NULL,
    kickoff TEXT,
    league TEXT,
    home TEXT,
    away TEXT,
    market TEXT NOT NULL,
    selection TEXT NOT NULL,
    probability REAL NOT NULL,
    fair_odds REAL,
    market_odds REAL,
    edge REAL,
    confidence REAL,
    data_quality REAL,
    agreement REAL,
    model_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    actual TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions(status);
  CREATE INDEX IF NOT EXISTS idx_predictions_market ON predictions(market);
  CREATE INDEX IF NOT EXISTS idx_predictions_created ON predictions(created_at);
  CREATE TABLE IF NOT EXISTS fixtures_cache (
    fixture_id INTEGER PRIMARY KEY,
    kickoff TEXT,
    league TEXT,
    home_id INTEGER,
    home TEXT,
    away_id INTEGER,
    away TEXT,
    status TEXT,
    goals_home INTEGER,
    goals_away INTEGER,
    corners_home INTEGER,
    corners_away INTEGER,
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'observed',
    league_logo TEXT,
    league_country TEXT,
    home_logo TEXT,
    away_logo TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fixtures_cache_home ON fixtures_cache(home_id);
  CREATE INDEX IF NOT EXISTS idx_fixtures_cache_away ON fixtures_cache(away_id);
  CREATE INDEX IF NOT EXISTS idx_fixtures_cache_kickoff ON fixtures_cache(kickoff);
`);

function resetQuotaWindow() {
  if (Date.now() - apiWindowStarted >= 86400000) {
    apiWindowStarted = Date.now();
    apiCalls = 0;
    apiQuotaExhausted = false; try { if (fs.existsSync(API_QUOTA_FILE)) fs.unlinkSync(API_QUOTA_FILE); } catch (_) {}
  }
}
function quotaInfo() {
  resetQuotaWindow();
  return { used: apiCalls, exhausted: apiQuotaExhausted, note: apiQuotaExhausted ? "Quota API-Football journalier épuisé — verrou local actif." : "Compteur local des appels effectués par cette instance." };
}
async function api(endpoint, params = {}, ttl = CACHE_TTL_MS) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY manquant.");
  resetQuotaWindow();
  if (apiQuotaExhausted) throw new Error("API-Football quota journalier épuisé (verrou local actif).");
  const url = new URL(API_BASE + endpoint);
  Object.entries(params).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v); });
  const key = url.toString();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  const r = await fetch(key, { headers: { "x-apisports-key": API_KEY } });
  apiCalls++;
  if (!r.ok) throw new Error(`API-Football HTTP ${r.status}`);
  const data = await r.json();
  if (data.errors && Object.keys(data.errors).length) { const msg=JSON.stringify(data.errors); if (/request limit for the day/i.test(msg)) { apiQuotaExhausted=true; fs.writeFileSync(API_QUOTA_FILE, JSON.stringify({exhaustedAt:Date.now()})); throw new Error("API-Football quota journalier épuisé."); } throw new Error(msg); }
  cache.set(key, { expires: Date.now() + ttl, data });
  return data;
}
function cacheFixtures(fixtures,source="observed"){
  const list=Array.isArray(fixtures)?fixtures:[];
  const stmt=db.prepare(`
    INSERT INTO fixtures_cache
    (fixture_id,kickoff,league,home_id,home,away_id,away,status,goals_home,goals_away,corners_home,corners_away,updated_at,source,league_logo,league_country,home_logo,away_logo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(fixture_id) DO UPDATE SET
      kickoff=excluded.kickoff,
      league=excluded.league,
      home_id=excluded.home_id,
      home=excluded.home,
      away_id=excluded.away_id,
      away=excluded.away,
      status=excluded.status,
      goals_home=COALESCE(excluded.goals_home,fixtures_cache.goals_home),
      goals_away=COALESCE(excluded.goals_away,fixtures_cache.goals_away),
      corners_home=COALESCE(excluded.corners_home,fixtures_cache.corners_home),
      corners_away=COALESCE(excluded.corners_away,fixtures_cache.corners_away),
      league_logo=COALESCE(excluded.league_logo,fixtures_cache.league_logo),
      league_country=COALESCE(excluded.league_country,fixtures_cache.league_country),
      home_logo=COALESCE(excluded.home_logo,fixtures_cache.home_logo),
      away_logo=COALESCE(excluded.away_logo,fixtures_cache.away_logo),
      updated_at=excluded.updated_at,
      source=excluded.source
  `);
  const now=new Date().toISOString();
  for(const f of list){
    const id=f?.fixture?.id;
    if(!id) continue;
    stmt.run(
      id,
      f.fixture?.date||null,
      f.league?.name||"",
      f.teams?.home?.id||null,
      f.teams?.home?.name||"",
      f.teams?.away?.id||null,
      f.teams?.away?.name||"",
      f.fixture?.status?.short||"",
      f.goals?.home??null,
      f.goals?.away??null,
      f.statistics?.find(x=>Number(x?.team?.id)===Number(f.teams?.home?.id))?.statistics?.find(x=>String(x?.type||"").toLowerCase().includes("corner"))?.value??null,
      f.statistics?.find(x=>Number(x?.team?.id)===Number(f.teams?.away?.id))?.statistics?.find(x=>String(x?.type||"").toLowerCase().includes("corner"))?.value??null,
      now,
      source,
      f.league?.logo||null,
      f.league?.country||null,
      f.teams?.home?.logo||null,
      f.teams?.away?.logo||null
    );
  }
}function cachedRecentTeam(teamId,limit=10,excludeId=null,beforeDate=null){
  const rows=db.prepare(`
    SELECT fixture_id,kickoff,league,home_id,home,away_id,away,status,
           goals_home,goals_away,corners_home,corners_away
    FROM fixtures_cache
    WHERE source IN ('observed','h2h') AND status IN ('FT','AET','PEN')
      AND (home_id=? OR away_id=?)
      AND kickoff < ?
      AND (? IS NULL OR fixture_id != ?)
    ORDER BY kickoff DESC
    LIMIT ?
  `).all(teamId,teamId,(beforeDate||new Date().toISOString()),excludeId,excludeId,limit);

  return rows.map(r=>({
    fixture:{id:r.fixture_id,date:r.kickoff,status:{short:r.status}},
    league:{name:r.league},
    teams:{
      home:{id:r.home_id,name:r.home},
      away:{id:r.away_id,name:r.away}
    },
    goals:{home:r.goals_home,away:r.goals_away},
    statistics:[
      {team:{id:r.home_id},statistics:[{type:"Corner Kicks",value:r.corners_home}]},
      {team:{id:r.away_id},statistics:[{type:"Corner Kicks",value:r.corners_away}]}
    ]
  }));
}

async function recentTeamHistory(teamId,limit=10,excludeId=null,beforeDate=null){
  if(apiQuotaExhausted) return cachedRecentTeam(teamId,limit,excludeId,beforeDate);
  let local=cachedRecentTeam(teamId,limit,excludeId,beforeDate);

  const currentYear=new Date().getUTCFullYear();

  for(const season of [currentYear,currentYear-1,currentYear-2]){
    try{
      const data=await api("/fixtures",{team:teamId,season},30*60*1000);
      const done=(data.response||[]).filter(f=>finished(f)&&f.fixture?.id!==excludeId);
      if(done.length) cacheFixtures(done,"observed");

      local=cachedRecentTeam(teamId,limit,excludeId,beforeDate);
      if(local.length>=limit) break;
    }catch(e){
      console.error("HISTORY_API_ERROR:",e.message);
      if(String(e.message).toLowerCase().includes("quota") || String(e.message).toLowerCase().includes("limit")) break;
    }
  }
  return local;
}
function localTeamHistory(teamId,limit=10,excludeId=null,beforeDate=null){ return cachedRecentTeam(teamId,limit,excludeId,beforeDate); }
function localCornerHistory(teamId,limit=10,excludeId=null){ return db.prepare(`SELECT fixture_id,kickoff,league,home_id,home,away_id,away,status,goals_home,goals_away,corners_home,corners_away FROM fixtures_cache WHERE source='observed' AND status IN ('FT','AET','PEN') AND (home_id=? OR away_id=?) AND corners_home IS NOT NULL AND corners_away IS NOT NULL AND kickoff < ? AND kickoff >= ? AND (? IS NULL OR fixture_id != ?) ORDER BY kickoff DESC LIMIT ?`).all(teamId,teamId,new Date().toISOString(),new Date(Date.now()-900*86400000).toISOString(),excludeId,excludeId,limit).map(r=>({fixture:{id:r.fixture_id,date:r.kickoff,status:{short:r.status}},league:{name:r.league},teams:{home:{id:r.home_id,name:r.home},away:{id:r.away_id,name:r.away}},goals:{home:r.goals_home,away:r.goals_away},statistics:[{team:{id:r.home_id},statistics:[{type:"Corner Kicks",value:r.corners_home}]},{team:{id:r.away_id},statistics:[{type:"Corner Kicks",value:r.corners_away}]}]})); }
async function enrichCorners(fixtures){
  for(const f of (fixtures||[])){
    const id=f?.fixture?.id,h=f?.teams?.home?.id,a=f?.teams?.away?.id;
    if(!id||!h||!a) continue;
    const c=db.prepare("SELECT corners_home,corners_away FROM fixtures_cache WHERE fixture_id=? LIMIT 1").get(id);
    if(c&&c.corners_home!=null&&c.corners_away!=null){
      f.statistics=[{team:{id:h},statistics:[{type:"Corner Kicks",value:Number(c.corners_home)}]},{team:{id:a},statistics:[{type:"Corner Kicks",value:Number(c.corners_away)}]}];
    }
  }
  return fixtures;
}
function topPickEligible(homeHistory,awayHistory,top){
  const homeN=homeHistory?.n||0;
  const awayN=awayHistory?.n||0;
  if(homeN<3 || awayN<3) return {eligible:false,reason:"Données insuffisantes"};
  if(!top) return {eligible:false,reason:"Aucun TOP PICK disponible"};
  const p=Number(top.probability)||0;
  if(p<0.55) return {eligible:false,reason:"Probabilité insuffisante"};
  if(top.edge!=null && Number(top.edge)<0) return {eligible:false,reason:"Pas de value détectée"};
  return {eligible:true,reason:"Données suffisantes et TOP PICK disponible"};
}

async function fixtureAnalysis(id){
  let f=null,pred=null,offline=apiQuotaExhausted;
  try{
    const fx=await api("/fixtures",{id});
    f=fx.response?.[0]||null;
    if(f) cacheFixtures([f]);
  }catch(e){if(!String(e.message).toLowerCase().includes("quota") && !String(e.message).toLowerCase().includes("limit")) console.error("HISTORY_API_ERROR:",e.message)}
  if(!f){
    f=localFixtureById(id);
    offline=true;
  }
  if(!f) throw new Error("Match introuvable dans l API et le cache local.");
  const homeId=f.teams.home.id, awayId=f.teams.away.id;
  if(!offline){
    try{
      const pr=await api("/predictions",{fixture:id});
      pred=pr.response?.[0]||null;
    }catch(e){console.error("HISTORY_API_ERROR:",e.message)}
  }
  const h10=await recentTeamHistory(homeId,10,id,f.fixture?.date);
  const hCorners=localCornerHistory(homeId,10,id);
  const a10=await recentTeamHistory(awayId,10,id,f.fixture?.date);
  const aCorners=localCornerHistory(awayId,10,id);
  const enrichedH=offline?h10:await enrichRecent(await enrichCorners(h10));
  const enrichedA=offline?a10:await enrichRecent(await enrichCorners(a10));
function summarize(fixtures,id,venue){
  const cornerFixtures=(id===homeId?hCorners:aCorners);
  let fs=(fixtures||[]).filter(f=>finished(f) && (f.teams?.home?.id===id || f.teams?.away?.id===id));
  if(venue==="home") fs=fs.filter(f=>f.teams?.home?.id===id);
  if(venue==="away") fs=fs.filter(f=>f.teams?.away?.id===id);
  fs.sort((a,b)=>new Date(b.fixture.date)-new Date(a.fixture.date));
  fs=fs.slice(0,10);
  const n=fs.length;
  const gf=[],ga=[],overs15=[],overs25=[],overs35=[],btts=[],cs=[],corn=[];
  let w=0,d=0,l=0;
  fs.forEach(f=>{
    const home=f.teams.home.id===id, x=f.goals.home, y=f.goals.away;
    if(x==null||y==null)return;
    const my=home?x:y, opp=home?y:x;
    gf.push(my); ga.push(opp);
    const r=resultFor(f,id); if(r==="W")w++; else if(r==="D")d++; else l++;
    overs15.push((x+y)>1?1:0); overs25.push((x+y)>2?1:0); overs35.push((x+y)>3?1:0);
    btts.push(x>0&&y>0?1:0); cs.push(opp===0?1:0);
    const cf=cornerFixtures.find(c=>Number(c.fixture?.id)===Number(f.fixture?.id)); if(cf){ const ch=cornersFromFixture(cf,id); if(ch!=null) corn.push(ch); }
  });
  return {n,w,d,l,winRate:n?w/n:null,pointsRate:n?(3*w+d)/(3*n):null,gf:mean(gf),ga:mean(ga),wgf:weightedMean(gf),wga:weightedMean(ga),over15:mean(overs15),over25:mean(overs25),over35:mean(overs35),btts:mean(btts),cleanSheet:mean(cs),corners:mean(corn),cornerN:corn.length,fixtures:fs};
}

  const hf=summarize(enrichedH||[],homeId); const hfFresh=historyFreshness(hf.fixtures);
  const af=summarize(enrichedA||[],awayId); const afFresh=historyFreshness(af.fixtures);
  let hhHistory=[];
  if(!offline){
    try{
      const hh=await api("/fixtures/headtohead",{h2h:`${homeId}-${awayId}`},60*60*1000);
      hhHistory=(hh.response||[]).filter(x=>finished(x)&&x.fixture?.id!==id);
      cacheFixtures(hhHistory,"h2h");
    }catch(e){console.error("HISTORY_API_ERROR:",e.message)}
  }
  const ap=getApiPrediction(pred);
  const hCornerValues=hCorners.map(x=>cornersFromFixture(x,homeId)).filter(x=>x!=null);
  const aCornerValues=aCorners.map(x=>cornersFromFixture(x,awayId)).filter(x=>x!=null);
  const m=model(hf,af,ap,hCornerValues,aCornerValues);
  const markets=marketList(m,hf,af);
  let odds=null;
  if(!offline){try{odds=await api("/odds",{fixture:id},30*60*1000);}catch(e){console.error("HISTORY_API_ERROR:",e.message)}}
  const withOdds=markets.map(x=>{
    const o=findOdds(odds,x.market,x.selection);
    const imp=implied(o);
    return {...x,marketOdds:o,implied:imp,edge:(imp!=null?x.probability-imp:null)};
  });
  const ranked=withOdds.filter(x=>x.market!=="Exact Score").sort((a,b)=>{const ae=a.edge==null?0:a.edge;const be=b.edge==null?0:b.edge;return (b.probability+Math.max(0,be)*0.5)-(a.probability+Math.max(0,ae)*0.5);}); const top=ranked[0]||null; const secondPick=ranked[1]||null;
  const cornerPick=withOdds.filter(x=>x.market==="Corners")[0]||null;
  const gate=shouldNoBet(top,m,hf.n,af.n,hfFresh,afFresh);
  let topEligibility=topPickEligible(hf,af,top);
  if(!hfFresh.fresh || !afFresh.fresh || hf.n<6 || af.n<6){
    gate.noBet=true;
    const parts=[];
    if(hf.n<6) parts.push(`équipe domicile ${hf.n}/10 matchs`);
    if(af.n<6) parts.push(`équipe extérieure ${af.n}/10 matchs`);
    if(!hfFresh.fresh && hfFresh.ageDays!=null) parts.push(`données domicile vieilles de ${hfFresh.ageDays} jours`);
    if(!afFresh.fresh && afFresh.ageDays!=null) parts.push(`données extérieures vieilles de ${afFresh.ageDays} jours`);
    gate.reason="Historique récent insuffisant : "+parts.join(", ")+"."; 
  }
  topEligibility=gate.noBet?{eligible:false,reason:gate.reason}:topEligibility;
  if(offline && !localDataAvailability(homeId,awayId,id).usable){
    gate.noBet=true;
    gate.reason="Données locales insuffisantes : API-Football indisponible ou quota épuisé.";
  }
  const cornerSignalResult=cornerSignal({...hf,cornerN:hCornerValues.length,corners:mean(hCornerValues)},{...af,cornerN:aCornerValues.length,corners:mean(aCornerValues)});
  return {
    fixture:f,apiPrediction:ap,homeForm:hf,awayForm:af,
    recentAvailability:{target:10,home:hf.n,away:af.n,homeComplete:hf.n>=10 && hfFresh.fresh,awayComplete:af.n>=10 && afFresh.fresh,homeLatestDate:hfFresh.latestDate,awayLatestDate:afFresh.latestDate,homeAgeDays:hfFresh.ageDays,awayAgeDays:afFresh.ageDays,homeFresh:hfFresh.fresh,awayFresh:afFresh.fresh},
    h2h:hhHistory.slice(0,5),model:m,markets:withOdds,
    topPick:gate.noBet?null:top,secondPick:gate.noBet?null:secondPick,topPickEligibility:topEligibility,topCornerPick:cornerPick,cornerSignal:cornerSignalResult,noBet:gate,
    qualityLabel:qualityLabel(m.quality*((hfFresh.fresh?1:0.5)+(afFresh.fresh?1:0.5))/2),quota:quotaInfo(),source:offline?"cache":"api"
  };
}
function recordPrediction(a,pick){
  const now=new Date().toISOString();
  const r=db.prepare(`SELECT id FROM predictions WHERE fixture_id=? AND market=? AND selection=?`)
    .get(a.fixture.fixture.id,pick.market,pick.selection);
  if(r)return r.id;
  const exactJson=pick.market==="Exact Score" ? JSON.stringify(a.model.score||[]) : null;
  const o=db.prepare(`INSERT INTO predictions (fixture_id,kickoff,league,home,away,market,selection,probability,fair_odds,market_odds,edge,confidence,data_quality,agreement,model_version,created_at,exact_scores_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.fixture.fixture.id,a.fixture.fixture.date,a.fixture.league?.name||"",a.fixture.teams.home.name,a.fixture.teams.away.name,pick.market,pick.selection,pick.probability,pick.fairOdds,pick.marketOdds,pick.edge,a.model.confidence??null,a.model.quality??null,a.model.agreement??null,MODEL_VERSION,now,exactJson);
  return o.lastInsertRowid;
}
function settleOne(p,fixture){
  const gh=fixture.goals?.home, ga=fixture.goals?.away;
  if(gh==null||ga==null)return null;
  let actual=null;

  if(p.market==="Exact Score"){
    actual=`${gh}-${ga}`;
  }else if(p.market==="1X2"){
    actual=p.selection==="1"?(gh>ga):p.selection==="X"?(gh===ga):(gh<ga);
  }else if(p.market==="Over/Under"){
    const m=p.selection.match(/[\d.]+/);
    if(!m)return null;
    actual=(gh+ga)>Number(m[0]);
  }else if(p.market==="BTTS"){
    actual=p.selection==="Yes"?(gh>0&&ga>0):(gh===0||ga===0);
  }else if(p.market==="Corners"){
    let c=0;
    for(const st of (fixture.statistics||[])){
      for(const row of (st.statistics||[])){
        if(row.type==="Corner Kicks"){
          const v=Number(String(row.value??"").replace(/[^\\d.-]/g,""));
          if(Number.isFinite(v))c+=v;
        }
      }
    }
    const m=p.selection.match(/[\d.]+/);
    if(!m)return null;
    actual=c>Number(m[0]);
  }

  return actual==null?null:actual;
}
async function settlePending(){
  const rows=db.prepare(`SELECT * FROM predictions WHERE status='PENDING' ORDER BY id ASC LIMIT 20`).all();
  if(!rows.length) return 0;

  const ids=[...new Set(rows.map(p=>p.fixture_id).filter(Boolean))].slice(0,20);
  let fixtures=[];
  try{
    const data=await api("/fixtures",{ids:ids.join("-")},60*1000);
    fixtures=data.response||[];
  }catch(e){
    console.warn("settle batch",e.message);
    fixtures=ids.map(id=>localFixtureById(id)).filter(Boolean);
  }

  const byId=new Map(fixtures.map(f=>[Number(f.fixture?.id),f]));
  let settled=0;
  const now=new Date().toISOString();

  for(const p of rows){
    const f=byId.get(Number(p.fixture_id));
    if(!f || !finished(f)) continue;
    const actual=settleOne(p,f); const isHit=p.market==="Exact Score" ? String(actual)===String(p.selection) : !!actual;
    if(actual==null) continue;
    db.prepare(`UPDATE predictions SET status=?,actual=?,settled_at=? WHERE id=?`)
      .run(isHit?"HIT":"MISS",String(actual),now,p.id);
    settled++;
  }
  return settled;
}
function performance(){
  const rows=db.prepare(`SELECT * FROM predictions ORDER BY id DESC`).all();
  const verified=rows.filter(x=>x.status!=="PENDING");
  const hits=verified.filter(x=>x.status==="HIT").length;
  const accuracy=verified.length?hits/verified.length:null;
  const brier=verified.length?verified.reduce((s,x)=>{
    const y=x.status==="HIT"?1:0; return s+Math.pow(x.probability-y,2);
  },0)/verified.length:null;
  const buckets=[[.5,.6],[.6,.7],[.7,.8],[.8,.9],[.9,1]].map(([lo,hi])=>{
    const rs=verified.filter(x=>x.probability>=lo && x.probability<hi+(hi===1?.0001:0));
    return {range:`${Math.round(lo*100)}–${Math.round(hi*100)}%`,n:rs.length,hitRate:rs.length?rs.filter(x=>x.status==="HIT").length/rs.length:null,avgProb:rs.length?mean(rs.map(x=>x.probability)):null};
  });
  const byMarket={};
  for(const x of verified){
    byMarket[x.market] ||= {n:0,hits:0};
    byMarket[x.market].n++; if(x.status==="HIT")byMarket[x.market].hits++;
  }
  const exactVerified=verified.filter(x=>x.market==="Exact Score" && x.exact_scores_json && x.actual); const exactStats={n:exactVerified.length,top1:0,top3:0,top5:0}; for(const x of exactVerified){try{const scores=JSON.parse(x.exact_scores_json); const i=scores.findIndex(s=>s.score===x.actual); if(i===0)exactStats.top1++; if(i>=0&&i<3)exactStats.top3++; if(i>=0&&i<5)exactStats.top5++;}catch{}} if(exactStats.n){exactStats.top1/=exactStats.n; exactStats.top3/=exactStats.n; exactStats.top5/=exactStats.n;}
  for(const k of Object.keys(byMarket)){byMarket[k].accuracy=byMarket[k].n?byMarket[k].hits/byMarket[k].n:null;}
  return {total:rows.length,verified:verified.length,pending:rows.length-verified.length,hits,accuracy,brier,calibration:buckets,byMarket,exactScoreStats:exactStats,latest:rows.slice(0,30),quota:quotaInfo()};
}

app.get("/api/status",(req,res)=>res.json({ok:true,model:MODEL_VERSION,apiConfigured:!!API_KEY,quota:quotaInfo()}));
function todayCornerEligibility(homeId,awayId){ const home=localCornerHistory(homeId,10,null).length; const away=localCornerHistory(awayId,10,null).length; const n=Math.min(home,away); return {home,away,cornerN:n,ready:n>=5}; }
function todayHistoryEligibility(homeId,awayId,beforeDate=null){
  const home=localTeamHistory(homeId,10,null,beforeDate).length;
  const away=localTeamHistory(awayId,10,null,beforeDate).length;
  return {home,away,ready:home>=6&&away>=6};
}
app.get("/api/today",async(req,res)=>{
  const tz="Africa/Abidjan";
  const d=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  try{
    const data=await api("/fixtures",{date:d},5*60*1000);
    cacheFixtures(data.response||[]);
    res.json({date:d,fixtures:(data.response||[]).map(f=>({...f,historyEligibility:todayHistoryEligibility(f.teams.home.id,f.teams.away.id,f.fixture?.date),cornerEligibility:todayCornerEligibility(f.teams.home.id,f.teams.away.id)})),quota:quotaInfo(),source:"api"});
  }catch(e){
    try{
      const rows=db.prepare("SELECT fixture_id,kickoff,league,home_id,home,away_id,away,status,goals_home,goals_away,league_logo,league_country,home_logo,away_logo FROM fixtures_cache WHERE status='NS' AND substr(kickoff,1,10) = ? ORDER BY kickoff ASC").all(d);
      const fixtures=rows.map(r=>({fixture:{id:r.fixture_id,date:r.kickoff,status:{short:r.status}},league:{name:r.league,logo:r.league_logo,country:r.league_country},teams:{home:{id:r.home_id,name:r.home,logo:r.home_logo},away:{id:r.away_id,name:r.away,logo:r.away_logo}},goals:{home:r.goals_home,away:r.goals_away}}));
      res.json({date:d,fixtures:fixtures.map(f=>({...f,historyEligibility:todayHistoryEligibility(f.teams.home.id,f.teams.away.id,f.fixture?.date),cornerEligibility:todayCornerEligibility(f.teams.home.id,f.teams.away.id)})),quota:quotaInfo(),source:"cache"});
    }catch(cacheErr){res.status(500).json({error:e.message});}
  }
});
app.get("/api/fixture/:id",async(req,res)=>{
  try{res.json(await fixtureAnalysis(Number(req.params.id)));}catch(e){console.error(e.stack);res.status(500).json({error:e.message});}
});
app.post("/api/predict/:id",async(req,res)=>{
  try{
    const a=await fixtureAnalysis(Number(req.params.id));
    if(a.noBet.noBet) return res.json({saved:false,noBet:a.noBet,analysis:a});
    const id=recordPrediction(a,a.topPick); const exactPick=a.model.score?.[0]; if(exactPick){const exactSelection=String(exactPick.h)+"-"+String(exactPick.a); const exactProb=Number(exactPick.p)||0; recordPrediction(a,{market:"Exact Score",selection:exactSelection,probability:exactProb,fairOdds:exactProb>0?1/exactProb:null,marketOdds:null,edge:null});}
    res.json({saved:true,predictionId:id,analysis:a});
  }catch(e){console.error(e.stack);res.status(500).json({error:e.message});}
});
app.post("/api/settle",async(req,res)=>{
  try{res.json({settled:await settlePending(),performance:performance()});}catch(e){console.error(e.stack);res.status(500).json({error:e.message});}
});
app.get("/api/performance",async(req,res)=>{
  try{
    if(Date.now()-lastSettlementAt >= 10*60*1000){
      await settlePending();
      lastSettlementAt=Date.now();
    }
    res.json(performance());
  }catch(e){console.error(e.stack);res.status(500).json({error:e.message});}
});
app.get("/api/predictions",async(req,res)=>res.json(performance().latest));

async function autoRefreshToday(){try{const tz="Africa/Abidjan";const d=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());const data=await api("/fixtures",{date:d},5*60*1000);if(data.response?.length)cacheFixtures(data.response);console.log("AUTO TODAY:",d,data.response?.length||0,"match(s)");}catch(e){console.log("AUTO TODAY:",e.message)}}
setInterval(autoRefreshToday,5*60*1000);
autoRefreshToday();
app.listen(PORT,()=>console.log(`Pronostic IA Gédéon V7 → http://localhost:${PORT}`));

function factorial(n){
  let r=1;
  for(let i=2;i<=n;i++) r*=i;
  return r;
}

function model(hf,af,ap,hCorners=[],aCorners=[]){
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));

  const hg=Number.isFinite(hf?.wgf)?hf.wgf:(Number.isFinite(hf?.gf)?hf.gf:1.2);
  const ag=Number.isFinite(af?.wgf)?af.wgf:(Number.isFinite(af?.gf)?af.gf:1.1);
  const hc=Number.isFinite(af?.wga)?af.wga:(Number.isFinite(af?.ga)?af.ga:1.1);
  const ac=Number.isFinite(hf?.wga)?hf.wga:(Number.isFinite(hf?.ga)?hf.ga:1.1);

  const xh=clamp((hg+ac)/2,0.15,4.5);
  const xa=clamp((ag+hc)/2,0.15,4.5);

  let total=0,homeWin=0,draw=0,awayWin=0;
  const scores=[];

  for(let h=0;h<=6;h++){
    for(let a=0;a<=6;a++){
      const ph=Math.exp(-xh)*Math.pow(xh,h)/factorial(h);
      const pa=Math.exp(-xa)*Math.pow(xa,a)/factorial(a);
      const p=ph*pa;

      total+=p;

      if(h>a) homeWin+=p;
      else if(h===a) draw+=p;
      else awayWin+=p;

      scores.push({h,a,p});
    }
  }

  homeWin/=total;
  draw/=total;
  awayWin/=total;

  return {
    homeWin:clamp(homeWin),
    draw:clamp(draw),
    awayWin:clamp(awayWin),
    expectedHomeGoals:xh,
    expectedAwayGoals:xa,
    totalGoals:xh+xa,
    score:scores.sort((a,b)=>b.p-a.p).slice(0,5).map(s=>({h:s.h,a:s.a,p:s.p})),
    expectedCorners:((hCorners?.length||0)>0 && (aCorners?.length||0)>0 && ((hCorners?.length||0)+(aCorners?.length||0))>=5) ? (mean(hCorners)+mean(aCorners)) : null,
    cornerN:((hCorners?.length||0)+(aCorners?.length||0)),
    apiWinner:ap?.winner||null,
    quality:clamp((Math.min(hf?.n||0,10)+Math.min(af?.n||0,10))/20),
    confidence:clamp(Math.max(homeWin,draw,awayWin)*0.50+((Math.min(hf?.n||0,10)+Math.min(af?.n||0,10))/20)*0.30+(ap?.percent?clamp(1-((Math.abs(homeWin-(Number.parseFloat(ap.percent.home)||0)/100)+Math.abs(draw-(Number.parseFloat(ap.percent.draw)||0)/100)+Math.abs(awayWin-(Number.parseFloat(ap.percent.away)||0)/100))/2))*0.20:0)),
    agreement:ap?.percent ? clamp(1-((Math.abs(homeWin-(Number.parseFloat(ap.percent.home)||0)/100)+Math.abs(draw-(Number.parseFloat(ap.percent.draw)||0)/100)+Math.abs(awayWin-(Number.parseFloat(ap.percent.away)||0)/100))/2)) : null,
  };
}

function marketList(m,hf,af){
  const clamp=(x)=>Math.max(0,Math.min(1,Number(x)||0));
  const poissonOver=(lambda,line)=>{
    let p=0;
    const max=Math.floor(line);
    let term=Math.exp(-lambda);
    for(let k=0;k<=max;k++){
      if(k>0) term*=lambda/k;
      p+=term;
    }
    return clamp(1-p);
  };

  const home=clamp(m?.homeWin);
  const draw=clamp(m?.draw);
  const away=clamp(m?.awayWin);
  const total=Number(m?.totalGoals)||2.3;

  const over15=poissonOver(total,1);
  const over25=poissonOver(total,2);
  const over35=poissonOver(total,3);

  const hg=Number(m?.expectedHomeGoals)||1.2;
  const ag=Number(m?.expectedAwayGoals)||1.1;
  const bttsYes=clamp((1-Math.exp(-hg))*(1-Math.exp(-ag)));

  const scores=(m?.score||[]).map(s=>({
    score:`${s.h}-${s.a}`,
    prob:clamp(s.p)
  }));

  const markets=[
    {market:"1X2",selection:"1",probability:home},
    {market:"1X2",selection:"X",probability:draw},
    {market:"1X2",selection:"2",probability:away},
    {market:"Over/Under",selection:"Over 1.5",probability:over15},
    {market:"Over/Under",selection:"Under 1.5",probability:1-over15},
    {market:"Over/Under",selection:"Over 2.5",probability:over25},
    {market:"Over/Under",selection:"Under 2.5",probability:1-over25},
    {market:"Over/Under",selection:"Over 3.5",probability:over35},
    {market:"Over/Under",selection:"Under 3.5",probability:1-over35},
    {market:"BTTS",selection:"Yes",probability:bttsYes},
    {market:"BTTS",selection:"No",probability:1-bttsYes},
    {market:"Double Chance",selection:"1X",probability:clamp(home+draw)},
    {market:"Double Chance",selection:"X2",probability:clamp(draw+away)},
    {market:"Double Chance",selection:"12",probability:clamp(home+away)}
  ];
  if(Number.isFinite(m?.expectedCorners) && (m?.cornerN||0)>=5){ const c=m.expectedCorners; let p8=0; let t8=Math.exp(-c); for(let k=0;k<=8;k++){ if(k>0)t8*=c/k; p8+=t8; } const over85=clamp(1-p8); markets.push({market:"Corners",selection:"Over 8.5",probability:over85}); markets.push({market:"Corners",selection:"Under 8.5",probability:1-over85}); }

  if(scores.length){
    markets.push({
      market:"Exact Score",
      selection:scores[0].score,
      probability:scores[0].prob
    });
  }

  return markets
    .map(x=>({
      ...x,
      probability:clamp(x.probability),
      fairOdds:x.probability>0?1/x.probability:null
    }))
    .sort((a,b)=>b.probability-a.probability);
}


function findOdds(odds,market,selection){
  if(!odds) return null;

  const list=Array.isArray(odds)
    ? odds
    : (odds.response||odds.bookmakers||[]);

  for(const item of list){
    const bookmakers=item.bookmakers||[item];

    for(const bookmaker of bookmakers){
      const bets=bookmaker.bets||[];

      for(const bet of bets){
        const values=bet.values||[];

        for(const v of values){
          const name=String(v.value||v.name||"").toLowerCase();
          const sel=String(selection||"").toLowerCase();

          if(name===sel || name.includes(sel) || sel.includes(name)){
            const odd=Number(v.odd);
            if(Number.isFinite(odd) && odd>0) return odd;
          }
        }
      }
    }
  }

  return null;
}

function implied(odd){
  const o=Number(odd);
  return Number.isFinite(o) && o>0 ? 1/o : null;
}

function shouldNoBet(top,m,hfN,afN,hfFresh,afFresh){
  if(!top) return {noBet:true,reason:"Aucun marché disponible"};
  const homeN=Math.min(Number(hfN)||0,10);
  const awayN=Math.min(Number(afN)||0,10);
  if(homeN<3 || awayN<3) return {noBet:true,reason:"Historique insuffisant : minimum 3 matchs récents par équipe",dataQuality:(homeN+awayN)/20};
  const p=Number(top.probability)||0;
  const edge=top.edge==null?null:Number(top.edge);
  const countQuality=(homeN+awayN)/20;
  const freshnessHome=hfFresh?.fresh?1:0;
  const freshnessAway=afFresh?.fresh?1:0;
  const freshnessQuality=(freshnessHome+freshnessAway)/2;
  const dataQuality=countQuality*freshnessQuality;
  const modelConfidence=Number(m?.confidence)||0;
  const confidence=modelConfidence;
  const agreement=m?.agreement==null?null:Number(m.agreement);
  if(dataQuality<0.55) return {noBet:true,reason:"Qualité des données insuffisante (<55%)",dataQuality,confidence,agreement};
  if(confidence<0.50) return {noBet:true,reason:"Confiance interne insuffisante (<50%)",dataQuality,confidence,agreement};
  if(agreement!=null && agreement<0.48) return {noBet:true,reason:"Accord modèles insuffisant (<48%)",dataQuality,confidence,agreement};
  if(p<0.55) return {noBet:true,reason:"Probabilité insuffisante",dataQuality,confidence,agreement};
  if(edge!=null && edge<0) return {noBet:true,reason:"Pas de value détectée",dataQuality,confidence,agreement};
  return {noBet:false,reason:"Conditions minimales satisfaites",dataQuality,confidence,agreement};
}
function cornersFromFixture(f,id){
  if(!f || !id) return null;

  const stats=f.statistics;
  if(!Array.isArray(stats)) return null;

  for(const teamStats of stats){
    if(teamStats?.team?.id!==id) continue;

    const corners=teamStats.statistics?.find(
      x=>String(x.type||"").toLowerCase().includes("corner")
    );

    if(corners){
      const value=String(corners.value??"").trim(); if(!value)return null; if(value==="") return null;
      const n=Number(value);
      if(Number.isFinite(n)) return n;
    }
  }

  return null;
}


function qualityLabel(q){
  const n=Number(q);

  if(!Number.isFinite(n)) return "Non évaluée";
  if(n>=0.80) return "Excellente";
  if(n>=0.65) return "Bonne";
  if(n>=0.50) return "Moyenne";
  return "Faible";
}

