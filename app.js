(() => {
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ---------- 기준값 (환경부 먹는물 수질기준) ---------- */
const STD = [
  {key:"turb", name:"탁도", unit:"NTU", show:"0.5 이하", test:v=>v<=0.5},
  {key:"cl",   name:"잔류염소", unit:"mg/L", show:"0.1 ~ 4", test:v=>v>=0.1&&v<=4},
  {key:"ph",   name:"pH", unit:"", show:"5.8 ~ 8.5", test:v=>v>=5.8&&v<=8.5},
];
const DEFAULT_MAP = "강서구=강서수도사업소 [확인 필요]\n양천구=강서수도사업소 [확인 필요]\n구로구=강서수도사업소 [확인 필요]";

/* ---------- Supabase 무료 플랜 한도 ---------- */
// 출처: https://supabase.com/docs/guides/platform/billing-on-supabase (2026-10-08 확인)
const WARN_AT = 0.8;

const LS = {
  get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
};
const cfg = window.ARISU_CONFIG || {};
const sb = (window.supabase && cfg.url && cfg.key) ? window.supabase.createClient(cfg.url, cfg.key) : null;
let user = null, readonly = false;
let settings = Object.assign({scale:1.15, theme:"", sound:true, map:DEFAULT_MAP, start:null, coins:0}, LS.get("aq_settings")||{});
let curDate = todayStr();
let day = emptyDay(curDate);
let shareToken = null;
const view = Object.assign({st:"all", gu:""}, LS.get("aq_view")||{});
const openIds = new Set(), foldOff = new Set();
let saveTimer=null, saving=Promise.resolve();

function todayStr(){const d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,10)}
function emptyDay(date){return {date, stops:[], measured:{turb:"",cl:"",ph:""}, routed:false}}
function shiftDate(s,n){const d=new Date(s+"T12:00:00");d.setDate(d.getDate()+n);return d.toISOString().slice(0,10)}
function uidGen(){return Math.random().toString(36).slice(2,9)}

/* ---------- 저장 (Supabase, 브라우저에도 사본) ---------- */
function dbError(e){
  const m = String(e?.message||e||"");
  if(/DAY_LIMIT/.test(m)) return limitAlert("저장할 수 있는 날짜 수(550일)를 넘었어요. 설정에서 오래된 기록을 지워 주세요.");
  if(/read-only/i.test(m)) return limitAlert("서버 저장 공간이 무료 한도(500MB)에 닿아 읽기 전용이 됐어요. 관리자에게 알려 주세요. 지금 입력은 이 휴대폰에만 남아 있어요.");
  if(/days_data_size|settings_data_size/.test(m)) return limitAlert("하루 목록이 너무 커서 저장하지 못했어요. 장소 수나 메모를 줄여 주세요.");
  toast("저장하지 못했어요. 인터넷 연결을 확인해 주세요");
}
function persistDay(){
  if(readonly) return;
  LS.set("aq_day_"+curDate, day);
  if(!sb||!user) return;
  clearTimeout(saveTimer);
  const snap = JSON.parse(JSON.stringify(day)), date=curDate;
  saveTimer = setTimeout(()=>{ saving = saving.then(async()=>{
    const {error} = await sb.from("days").upsert({user_id:user.id, date, data:snap}, {onConflict:"user_id,date", returning:"minimal"});
    if(error) dbError(error);
  }); }, 900);
}
let setTimer=null;
function persistSettings(){
  LS.set("aq_settings", settings);
  if(!sb||!user||readonly) return;
  clearTimeout(setTimer);
  const snap=JSON.parse(JSON.stringify(settings));
  setTimer=setTimeout(()=>{ saving = saving.then(async()=>{
    const {error}=await sb.from("settings").upsert({user_id:user.id, data:snap}, {onConflict:"user_id", returning:"minimal"});
    if(error) dbError(error);
  }); },1200);
}
async function loadDay(date){
  curDate=date; shareToken=null;
  day = LS.get("aq_day_"+date) || emptyDay(date);
  render();
  if(sb&&user){
    const {data,error} = await sb.from("days").select("data,share_token").eq("date",date).maybeSingle();
    if(curDate!==date) return;
    if(!error&&data){ day=Object.assign(emptyDay(date), data.data); shareToken=data.share_token; LS.set("aq_day_"+date, day); render(); }
  }
  maybeIntro();
}

/* ---------- 관할 ---------- */
function officeMap(){
  const m={};
  String(settings.map||"").split(/\n/).forEach(l=>{const i=l.indexOf("=");if(i>0)m[l.slice(0,i).trim()]=l.slice(i+1).trim()});
  return m;
}
function guOf(s){ if(s.gu) return s.gu; const m=String(s.addr||"").match(/([가-힣]{1,4}구)(?=\s|$)/); return m?m[1]:""; }
function officeOf(s){ const g=guOf(s); return g ? (officeMap()[g] || "") : ""; }

/* ---------- 거리·시간 추정 ---------- */
function km(a,b){const R=6371,t=x=>x*Math.PI/180;const dl=t(b.lat-a.lat),dg=t(b.lng-a.lng);
  const h=Math.sin(dl/2)**2+Math.cos(t(a.lat))*Math.cos(t(b.lat))*Math.sin(dg/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
const hasXY = s => s && s.lat!==null && s.lng!==null && s.lat!=="" && s.lng!=="" && s.lat!==undefined && isFinite(+s.lat) && isFinite(+s.lng);
function est(a,b){
  const d=km(a,b), road=d*1.35;
  return {d, car:Math.round(road/22*60+3), walk:Math.round(d*1.25/4.5*60), transit: d<0.8 ? Math.round(d*1.25/4.5*60) : Math.round(8+road/16*60)};
}
function fmtMin(m){return m>=60? Math.floor(m/60)+"시간 "+(m%60)+"분" : m+"분"}
function kakaoLeg(a,b){
  const nm=s=>encodeURIComponent((s.name||s.addr||"장소").replace(/[,/]/g," "));
  if(hasXY(a)&&hasXY(b)&&a!==b) return `https://map.kakao.com/link/from/${nm(a)},${a.lat},${a.lng}/to/${nm(b)},${b.lat},${b.lng}`;
  if(hasXY(b)) return `https://map.kakao.com/link/to/${nm(b)},${b.lat},${b.lng}`;
  return `https://map.kakao.com/link/search/${encodeURIComponent(b.addr||b.name||"")}`;
}

/* ---------- 동선 ---------- */
function planRoute(){
  const groups={};
  day.stops.forEach(s=>{const o=officeOf(s)||"관할 미지정";(groups[o]=groups[o]||[]).push(s)});
  let cur = hasXY(settings.start) ? settings.start : null;
  const centroid=g=>{const p=g.filter(hasXY);if(!p.length)return null;return {lat:p.reduce((a,s)=>a+ +s.lat,0)/p.length,lng:p.reduce((a,s)=>a+ +s.lng,0)/p.length}};
  const left=new Set(Object.keys(groups)), ordered=[];
  while(left.size){
    let best=null,bd=Infinity;
    for(const n of left){const c=centroid(groups[n]);const d=(cur&&c)?km(cur,c):(c?1e3:1e6);if(d<bd){bd=d;best=n}}
    left.delete(best);
    const seq=nn(groups[best],cur); seq.forEach(s=>ordered.push(s));
    const lastXY=[...seq].reverse().find(hasXY); if(lastXY)cur=lastXY;
  }
  ordered.forEach((s,i)=>s.order=i);
  day.stops=ordered; day.routed=true;
}
function nn(list,start){
  const no=list.filter(s=>!hasXY(s)); let pool=list.filter(hasXY);
  const out=[]; let cur=start;
  if(!cur && pool.length){ pool.sort((a,b)=>a.lng-b.lng); cur=pool[0]; }
  while(pool.length){let bi=0,bd=Infinity;pool.forEach((s,i)=>{const d=km(cur,s);if(d<bd){bd=d;bi=i}});cur=pool.splice(bi,1)[0];out.push(cur)}
  let improved=true,guard=0;
  while(improved&&guard++<40){improved=false;
    for(let i=0;i<out.length-2;i++)for(let k=i+1;k<out.length-1;k++){
      const a=out[i],b=out[i+1],c=out[k],d=out[k+1];
      if(km(a,c)+km(b,d)+1e-9<km(a,b)+km(c,d)){out.splice(i+1,k-i,...out.slice(i+1,k+1).reverse());improved=true}
    }}
  return out.concat(no);
}

/* ---------- 캐릭터 아리 ---------- */
const ARI_BASE=["......BB......",".....BLLB.....","....BLWLLB....","...BLWLLLLB...","..BLWLLLLLLB..",".BLLLLLLLLLLB.",".BLLLLLLLLLLB.",
"BLLLKLLLLKLLLB","BLLLKLLLLKLLLB","BLPPLLMMLLPPLB","BLLLLLLLLLLLLB",".BLLLLLLLLLLB.","..BLLLLLLLLB..","...BBBBBBBB..."];
function ari(mood){
  const g=ARI_BASE.map(r=>r.split(""));
  if(mood==="happy"){ g[7]="BLLLKLLLLKLLLB".split(""); g[8]="BLLKLKLLKLKLLB".split(""); g[7][4]="L";g[7][9]="L";g[7][4]="K";g[7][9]="K"; g[8][4]="L"; g[8][9]="L"; g[9]="BLPPLMLLMLPPLB".split(""); g[10]="BLLLLLMMLLLLLB".split(""); }
  if(mood==="sleepy"){ g[7]="BLLLLLLLLLLLLB".split(""); g[8]="BLLKKLLLLKKLLB".split(""); }
  const col={B:"#3D7FB5",L:"#9EDCFF",W:"#FFFFFF",K:"#3A2450",P:"#FF9CC2",M:"#3A2450"};
  let r="";g.forEach((row,y)=>row.forEach((c,x)=>{if(col[c])r+=`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${col[c]}"/>`}));
  return `<svg viewBox="0 0 14 14" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
}
const CHEERS=["오늘도 맑은 물 지키러 가자!","물 한 잔 마시고 가요 ♥","천천히 해도 괜찮아","너무 잘하고 있어!","아리가 응원할게 ♥","오늘 날씨처럼 맑은 하루!"];
let ariMoodTimer=null;
function ariSay(text, mood, sub){
  const b=$("#ariBtn"); if(!b) return;
  b.innerHTML=`<div class="ari-bob">${ari(mood||"normal")}</div>`;
  $("#ariSay").innerHTML=esc(text)+(sub?`<small>${esc(sub)}</small>`:"");
}
function ariStatus(){
  if(readonly) return ariSay("공유받은 목록이야! 보기만 할 수 있어.","normal");
  const t=day.stops.length, left=day.stops.filter(s=>!s.done).length;
  if(!t) return ariSay("안녕! 나는 물방울 아리야. 오늘 갈 곳 사진을 올려 줘!","normal","사진을 올리면 목록이랑 동선을 만들어 줄게");
  if(!left) return ariSay("오늘 의뢰 다 끝났다! 최고야 ♥","happy","푹 쉬어요");
  ariSay(`남은 의뢰 ${left}건! ${CHEERS[new Date().getDate()%CHEERS.length]}`, left===t?"normal":"happy", `완료 ${t-left} / ${t}`);
}
function ariJump(text){
  const b=$("#ariBtn"); if(!b) return;
  clearTimeout(ariMoodTimer);
  b.innerHTML=`<div class="ari-jump">${ari("happy")}</div>`;
  if(text) $("#ariSay").textContent=text;
  hearts(b,5);
  ariMoodTimer=setTimeout(ariStatus,2200);
}
function hearts(el,n){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r=el.getBoundingClientRect();
  for(let i=0;i<n;i++){const h=document.createElement("span");h.className="heart";h.textContent="\u2665";
    h.style.left=(r.left+r.width/2-8+(Math.random()*40-20))+"px";h.style.top=(r.top+10)+"px";document.body.appendChild(h);
    h.animate([{transform:"translateY(0) scale(.6)",opacity:1},{transform:`translate(${Math.random()*40-20}px,-70px) scale(1.2)`,opacity:0}],{duration:900+i*120,easing:"ease-out"}).onfinish=()=>h.remove();}
}

/* ---------- 렌더 ---------- */
const WD=["일","월","화","수","목","금","토"];
function isDark(){return settings.theme? settings.theme==="dark" : matchMedia("(prefers-color-scheme: dark)").matches}
function render(){
  document.documentElement.style.setProperty("--scale", settings.scale);
  if(settings.theme) document.documentElement.setAttribute("data-theme",settings.theme); else document.documentElement.removeAttribute("data-theme");
  $("#themeBtn").textContent = isDark()?"☀":"☾";
  const d=new Date(curDate+"T12:00:00");
  $("#dateLabel").textContent = `${d.getMonth()+1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
  $("#dateSub").textContent = readonly ? "공유받은 목록" : curDate===todayStr()?"오늘의 의뢰":(curDate<todayStr()?"지난 의뢰":"예정 의뢰");
  $("#datePick").value=curDate;
  renderStd(); renderRoute(); renderHud(); ariStatus();
  const la=$("#logoAri"); if(la&&!la.innerHTML) la.innerHTML=`<span class="ari-s" style="display:inline-block;width:1.9rem">${ari("happy")}</span>`;
  const st=settings.start;
  $("#startLabel").textContent = st&&(st.name||st.addr) ? `출발지: ${st.name||st.addr}${hasXY(st)?"":" (좌표 없음)"}` : "출발지: 설정에서 지정 (없으면 서쪽 끝 장소부터)";
}
function verdict(k,v){ if(v===""||v==null||isNaN(+v)) return ""; return STD.find(s=>s.key===k).test(+v)?"ok":"bad"; }
function renderStd(){
  const box=$("#stdBox");
  if(box.dataset.h) return;
  box.innerHTML = STD.map(s=>`<div class="gauge"><span class="k">${s.name}</span><span class="v">${s.show}</span><span class="u">${s.unit||"&nbsp;"}</span></div>`).join("");
  box.dataset.h="1";
}
function renderHud(){
  const t=day.stops.length, dn=day.stops.filter(s=>s.done).length;
  $("#expBar").style.width = t? (dn/t*100)+"%" : "0%";
  $("#questCount").textContent=`${dn} / ${t}`;
  $("#coins").textContent=settings.coins||0;
  $("#lv").textContent="LV "+(1+Math.floor((settings.coins||0)/20));
}
const OFF_COL=["var(--taxi)","var(--water)","var(--pink)","var(--ok)"];
function renderRoute(){
  const out=$("#routeOut");
  if(!day.stops.length){
    out.innerHTML=`<div class="empty"><div style="width:3.2rem">${ari("sleepy")}</div>
      <div style="font-weight:700;font-size:1.05rem">아직 접수된 의뢰가 없어요</div>
      <div class="small muted">오른쪽 위 "＋ 접수"로 방문 목록 사진을 올리면 수도사업소별로 동선을 짜 드려요.</div>
      ${readonly?"":'<div class="row" style="justify-content:center"><button class="btn y sm" id="emptyAdd">＋ 접수하기</button><button class="btn sm" id="demoBtn">예시로 둘러보기</button></div>'}</div>`;
    const db=$("#demoBtn"); if(db) db.onclick=loadDemo; const ea=$("#emptyAdd"); if(ea) ea.onclick=()=>showIntake(true); return;
  }
  const stops=[...day.stops].sort((a,b)=>(a.order??0)-(b.order??0));
  const show=s=>(view.st==="all"||(view.st==="todo"?!s.done:s.done))&&(!view.gu||guOf(s)===view.gu);
  const gus=[...new Set(stops.map(guOf).filter(Boolean))];
  if(view.gu&&!gus.includes(view.gu)) view.gu="";
  const doneN=stops.filter(x=>x.done).length;
  const seg=(k,l)=>`<button class="fchip ${view.st===k?"on":""}" data-flt="st" data-v="${k}" aria-pressed="${view.st===k}">${l}</button>`;
  const guB=(g,l)=>`<button class="fchip ${view.gu===g?"on":""}" data-flt="gu" data-v="${esc(g)}" aria-pressed="${view.gu===g}">${esc(l)}</button>`;
  let bar=`<div class="fbar">
    <div class="frow">${seg("all",`전체 ${stops.length}`)}${seg("todo",`남은 곳 ${stops.length-doneN}`)}${seg("done",`완료 ${doneN}`)}</div>
    ${gus.length>1?`<div class="frow">${guB("","모든 구")}${gus.map(g=>guB(g,g)).join("")}</div>`:""}
    <div class="frow end"><button class="fchip ghost" data-flt="open" data-v="${openIds.size?"0":"1"}">${openIds.size?"모두 접기":"모두 펼치기"}</button></div>
  </div>`;
  let html="", prev=hasXY(settings.start)&&!readonly?{...settings.start,name:settings.start.name||"출발지"}:null, lastOffice=null, oi=-1, n=0, tot={car:0,walk:0,transit:0,d:0}, unknownLeg=0, shown=0;
  html+=`<ol class="list">`;
  for(const s of stops){
    const off=officeOf(s)||"관할 미지정";
    if(off!==lastOffice){oi++;lastOffice=off;
      const cnt=stops.filter(x=>(officeOf(x)||"관할 미지정")===off);
      if(cnt.some(show)){ const folded=foldOff.has(off);
        html+=`</ol><div class="office"><button class="office-h" data-flt="fold" data-v="${esc(off)}" aria-expanded="${!folded}"><span class="sw" style="background:${OFF_COL[oi%4]}"></span>${esc(off.replace(" [확인 필요]",""))}${off.includes("[확인 필요]")?' <span class="chip q">관할 [확인 필요]</span>':""}<span class="cnt">${cnt.filter(x=>x.done).length}/${cnt.length} 완료</span><span class="caret">${folded?"▸":"▾"}</span></button></div><ol class="list">`;
      }
    }
    n++;
    let leg="", eta="";
    if(prev){
      if(hasXY(prev)&&hasXY(s)){const e=est(prev,s);tot.car+=e.car;tot.walk+=e.walk;tot.transit+=e.transit;tot.d+=e.d;
        eta=`<span class="eta" title="이전 장소에서 자동차">🚗${fmtMin(e.car)}</span>`;
        leg=`<div class="leg"><span>${esc(prev.name||"이전")}에서 ${e.d.toFixed(1)}km</span><span>자동차 <b>${fmtMin(e.car)}</b></span><span>도보 <b>${fmtMin(e.walk)}</b></span><span>대중교통 <b>${fmtMin(e.transit)}</b></span><a href="${kakaoLeg(prev,s)}" target="_blank" rel="noopener">길찾기 ↗</a></div>`;
      } else {unknownLeg++; eta=`<span class="eta q">?</span>`; leg=`<div class="leg"><span class="need">좌표 없음 · 소요시간 [확인 필요]</span><a href="${kakaoLeg(prev,s)}" target="_blank" rel="noopener">길찾기 ↗</a></div>`}
    }
    const legPrev=prev;
    if(hasXY(s)) prev=s; else prev=prev||s;
    if(!show(s)||foldOff.has(off)) continue;
    shown++;
    const gu=guOf(s), offRaw=officeOf(s), m=s.meas||{}, open=openIds.has(s.id);
    html+=`<li class="stop ${s.done?"done":""} ${open?"open":""}" data-id="${s.id}">
      <input type="checkbox" class="chk" id="chk-${s.id}" ${s.done?"checked":""} ${readonly?"disabled":""} aria-label="${esc(s.name)} 완료">
      <button class="sum" data-flt="toggle" aria-expanded="${open}">
        <span class="num">${String(n).padStart(2,"0")}</span>
        <span class="tx"><span class="nm">${esc(s.name||"이름 없음")}</span>
        <span class="mini">${gu?esc(gu):'<span class="need">구 [확인 필요]</span>'}${s.dong?" · "+esc(s.dong):""}${s.example?" · 예시":""}</span></span>
        ${eta}<span class="caret">${open?"▾":"▸"}</span>
      </button>
      ${open?`<div class="detail">
        ${leg}
        <div class="addr">${esc(s.addr||"")}</div>
        <div class="chips">
          ${gu?`<span class="chip gu">서울 ${esc(gu)}</span>`:`<span class="chip q">자치구 [확인 필요]</span>`}
          ${s.dong?`<span class="chip">${esc(s.dong)}${s.dongSure===false?" (추정)":""}</span>`:`<span class="chip q">행정동 [확인 필요]</span>`}
          ${offRaw?`<span class="chip of">${esc(offRaw.replace(" [확인 필요]",""))}</span>`:`<span class="chip q">관할 사업소 [확인 필요]</span>`}
          ${hasXY(s)&&s.xyEst?'<span class="chip q">좌표 추정</span>':""}
        </div>
        ${s.note?`<div class="note">${esc(s.note)}</div>`:""}
        <details><summary class="small">현장 측정값</summary>
          <div class="meas">${STD.map(t=>`<label>${t.name}<input data-m="${t.key}" id="m-${s.id}-${t.key}" inputmode="decimal" value="${esc(m[t.key]??"")}" class="${verdict(t.key,m[t.key]??"")}" ${readonly?"readonly":""}></label>`).join("")}</div>
        </details>
        <div class="acts">
          <a class="btn sm" href="${kakaoLeg(legPrev||s,s)}" target="_blank" rel="noopener">지도</a>
          ${readonly?"":`<button class="btn sm" data-act="edit">수정</button>
          <button class="btn sm" data-act="up" aria-label="위로">▲</button>
          <button class="btn sm" data-act="down" aria-label="아래로">▼</button>
          <button class="btn sm ghost" data-act="del">삭제</button>`}
        </div>
      </div>`:""}
    </li>`;
  }
  html+=`</ol>`;
  if(!shown) html+=`<p class="small muted" style="text-align:center;margin:1rem 0">조건에 맞는 장소가 없어요.</p>`;
  const sum = tot.d? `<div class="px" style="margin-top:1rem;box-shadow:none;padding:.7rem"><div class="small" style="font-weight:800">총 이동 (추정${unknownLeg?`, 좌표 없는 ${unknownLeg}구간 제외`:""})</div>
     <div class="row small" style="gap:.4rem 1rem"><span>${tot.d.toFixed(1)}km</span><span>자동차 <b>${fmtMin(tot.car)}</b></span><span>도보 <b>${fmtMin(tot.walk)}</b></span><span>대중교통 <b>${fmtMin(tot.transit)}</b></span></div></div>`:"";
  out.innerHTML = (day.routed||readonly?"":'<p class="small need" style="margin:.6rem 0 0">아직 동선 정렬 전이에요. "동선 짜기"를 눌러 주세요.</p>') + bar + html.replace(/<ol class="list">\s*<\/ol>/g,"") + sum;
}
function pixTaxi(){
  const rows=["....YYYYY....","...Y.WW.WY...","YYYYYYYYYYYYY","YYKYYYYYYYKYY",".KKK.....KKK."];
  const col={Y:"var(--taxi)",W:"var(--water)",K:"var(--ink)"};
  let r="";rows.forEach((row,y)=>[...row].forEach((c,x)=>{if(col[c])r+=`<rect x="${x}" y="${y}" width="1" height="1" fill="${col[c]}"/>`}));
  return `<svg class="pixtaxi" viewBox="0 0 13 5" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
}

/* ---------- 목록 이벤트 ---------- */
$("#routeOut").addEventListener("change",e=>{
  if(readonly) return;
  const li=e.target.closest(".stop"); if(!li) return;
  const s=day.stops.find(x=>x.id===li.dataset.id); if(!s) return;
  if(e.target.classList.contains("chk")){
    s.done=e.target.checked; s.doneAt=s.done?new Date().toISOString():null;
    if(!s.example){settings.coins=Math.max(0,(settings.coins||0)+(s.done?1:-1)); persistSettings();}
    persistDay(); render();
    if(s.done){ const st=$("#stamp-"+s.id); if(st) st.classList.add("pop"); blip(); burst($(`[data-id="${s.id}"]`)); ariJump(`${s.name} 완료! 잘했어 ♥`);
      if(day.stops.every(x=>x.done)) setTimeout(allClear,500); }
  }
});
$("#routeOut").addEventListener("input",e=>{
  const k=e.target.dataset.m; if(!k||readonly) return;
  const li=e.target.closest(".stop"); const s=day.stops.find(x=>x.id===li.dataset.id);
  s.meas=s.meas||{}; s.meas[k]=e.target.value.trim(); e.target.className=verdict(k,s.meas[k]); persistDay();
});
$("#routeOut").addEventListener("click",e=>{
  const f=e.target.closest("[data-flt]");
  if(f){ const k=f.dataset.flt, v=f.dataset.v;
    if(k==="st"||k==="gu"){ view[k]=v; LS.set("aq_view",view); }
    if(k==="fold"){ foldOff.has(v)?foldOff.delete(v):foldOff.add(v); }
    if(k==="toggle"){ const id=f.closest(".stop").dataset.id; openIds.has(id)?openIds.delete(id):openIds.add(id); }
    if(k==="open"){ openIds.clear(); if(v==="1") day.stops.forEach(x=>openIds.add(x.id)); }
    renderRoute(); return;
  }
  const b=e.target.closest("[data-act]"); if(!b||readonly) return;
  const li=b.closest(".stop"); const i=day.stops.findIndex(x=>x.id===li.dataset.id); const s=day.stops[i];
  const act=b.dataset.act;
  if(act==="del") confirmBox(`"${s.name}"을(를) 삭제할까요?`,()=>{day.stops.splice(i,1);persistDay();render()});
  if(act==="edit") editStop(s);
  if(act==="up"||act==="down"){
    const arr=[...day.stops].sort((a,b)=>(a.order??0)-(b.order??0)); const j=arr.indexOf(s); const k=act==="up"?j-1:j+1;
    if(k<0||k>=arr.length) return; [arr[j],arr[k]]=[arr[k],arr[j]]; arr.forEach((x,n)=>x.order=n); day.stops=arr; persistDay(); render();
  }
});

/* ---------- 오버레이 ---------- */
function openLayer(html, sticky){ $("#layer").innerHTML=`<div class="ov" role="dialog" aria-modal="true">${html}</div>`; const ov=$("#layer .ov"); if(!sticky) ov.addEventListener("click",e=>{if(e.target===ov)closeLayer()}); return ov; }
function closeLayer(){ $("#layer").innerHTML=""; }
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&user)closeLayer()});
function toast(msg){ const t=document.createElement("div"); t.className="toast"; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),2800); }
function confirmBox(msg,yes){
  const ov=openLayer(`<div class="px sheet"><div style="font-weight:700;font-size:1.05rem">${esc(msg)}</div><div class="row"><button class="btn y" id="cfYes">예</button><button class="btn" id="cfNo">아니오</button></div></div>`);
  ov.querySelector("#cfYes").onclick=()=>{closeLayer();yes()}; ov.querySelector("#cfNo").onclick=closeLayer;
}
function limitAlert(msg){
  const b=$("#limitBanner"); b.hidden=false; b.innerHTML=`<strong>사용량 알림</strong><div>${esc(msg)}</div>`;
  const ov=openLayer(`<div class="term"><div class="t-h"><span>WARNING</span><span>LIMIT</span></div><div class="t-ari">${ari("sleepy")}</div><div class="typed" style="min-height:0">${esc(msg)}</div><div class="opts"><button class="opt" id="ok">확인</button></div></div>`);
  ov.querySelector("#ok").onclick=closeLayer; tone(220,.25,0,"square",.05); tone(180,.3,.25,"square",.05);
}
function editStop(s, isNew){
  s=s||{id:uidGen(),name:"",addr:"",gu:"",dong:"",lat:null,lng:null,note:""};
  const ov=openLayer(`<form class="px sheet" id="edForm"><div class="px-h"><h2>${isNew?"장소 추가":"장소 수정"}</h2></div>
    <label>장소명<input class="inp" id="ed-name" value="${esc(s.name)}" required></label>
    <label>주소<input class="inp" id="ed-addr" value="${esc(s.addr)}"></label>
    <div class="grid2"><label>자치구<input class="inp" id="ed-gu" value="${esc(s.gu)}" placeholder="예) 강서구"></label>
    <label>행정동<input class="inp" id="ed-dong" value="${esc(s.dong)}" placeholder="예) 화곡1동"></label></div>
    <div class="grid2"><label>위도<input class="inp" id="ed-lat" inputmode="decimal" value="${esc(s.lat??"")}"></label>
    <label>경도<input class="inp" id="ed-lng" inputmode="decimal" value="${esc(s.lng??"")}"></label></div>
    <label>메모<input class="inp" id="ed-note" value="${esc(s.note)}"></label>
    <div class="row"><button class="btn y" type="submit">저장</button><button class="btn" type="button" id="edCancel">취소</button></div></form>`);
  ov.querySelector("#edCancel").onclick=closeLayer;
  ov.querySelector("#edForm").addEventListener("submit",e=>{e.preventDefault();
    const g=id=>ov.querySelector(id).value.trim();
    const lat=g("#ed-lat"),lng=g("#ed-lng"), oldAddr=s.addr;
    const changedXY = String(lat)!==String(s.lat??"")||String(lng)!==String(s.lng??"");
    Object.assign(s,{name:g("#ed-name"),addr:g("#ed-addr"),gu:g("#ed-gu"),dong:g("#ed-dong"),note:g("#ed-note"),lat:lat===""?null:+lat,lng:lng===""?null:+lng});
    if(changedXY) s.xyEst=false;
    if(!changedXY && oldAddr!==s.addr){ s.lat=null; s.lng=null; }
    if(g("#ed-dong")) s.dongSure=true;
    if(isNew){s.order=day.stops.length;day.stops.push(s);showIntake(false)}
    persistDay(); closeLayer(); render(); toast("저장했어요");
    if(!hasXY(s)&&s.addr) geocodeStops([s]);
  });
}
function openSettings(){
  const st=settings.start||{};
  const ov=openLayer(`<form class="px sheet" id="setForm"><div class="px-h"><h2>설정</h2><span class="tag">OPTION</span></div>
    <div class="small muted">${user?`접속 계정: <b>${esc(idOf(user))}</b>`:""}</div>
    <label>출발지 이름<input class="inp" id="st-name" value="${esc(st.name||"")}" placeholder="예) 사무실"></label>
    <label>출발지 주소<input class="inp" id="st-addr" value="${esc(st.addr||"")}"></label>
    <div class="grid2"><label>출발지 위도<input class="inp" id="st-lat" inputmode="decimal" value="${esc(st.lat??"")}"></label>
    <label>출발지 경도<input class="inp" id="st-lng" inputmode="decimal" value="${esc(st.lng??"")}"></label></div>
    <button class="btn sm" type="button" id="stFind">주소로 좌표 찾기</button>
    <label>자치구별 관할 수도사업소 (한 줄에 "자치구=사업소")<textarea id="st-map">${esc(settings.map)}</textarea></label>
    <p class="src" style="margin:0">기본값은 공식 자료로 확인하지 못해 [확인 필요]가 붙어 있어요. 확인되면 문구를 지워 주세요.</p>
    <label style="flex-direction:row;align-items:center;gap:.5rem"><input type="checkbox" id="st-sound" ${settings.sound?"checked":""}> 효과음 켜기</label>
    <div class="row"><button class="btn y" type="submit">저장</button><button class="btn" type="button" id="stCancel">닫기</button></div>
    <div class="row"><button class="btn sm" type="button" id="usageBtn">서버 사용량 보기</button><button class="btn sm" type="button" id="oldBtn">1년 지난 기록 지우기</button><button class="btn sm ghost" type="button" id="logoutBtn">로그아웃</button></div></form>`);
  ov.querySelector("#stCancel").onclick=closeLayer;
  ov.querySelector("#stFind").onclick=async()=>{
    const addr=ov.querySelector("#st-addr").value.trim(); if(!addr){toast("출발지 주소를 먼저 넣어 주세요");return}
    const r=await geocode(addr); if(r){ov.querySelector("#st-lat").value=r.lat;ov.querySelector("#st-lng").value=r.lng;toast("좌표를 넣었어요. 지도에서 한 번 확인해 주세요")} else toast("좌표를 찾지 못했어요. 도로명 주소로 다시 시도해 주세요");
  };
  ov.querySelector("#usageBtn").onclick=()=>checkUsage(true);
  ov.querySelector("#oldBtn").onclick=()=>confirmBox("1년이 지난 날짜 기록을 모두 지울까요?",async()=>{
    const cut=shiftDate(todayStr(),-365); const {error}=await sb.from("days").delete().lt("date",cut); error?dbError(error):toast("오래된 기록을 지웠어요")});
  ov.querySelector("#logoutBtn").onclick=async()=>{await sb.auth.signOut(); location.reload()};
  ov.querySelector("#setForm").addEventListener("submit",e=>{e.preventDefault();
    const g=id=>ov.querySelector(id).value.trim();
    const lat=g("#st-lat"),lng=g("#st-lng");
    settings.start={name:g("#st-name"),addr:g("#st-addr"),lat:lat===""?null:+lat,lng:lng===""?null:+lng};
    settings.map=ov.querySelector("#st-map").value; settings.sound=ov.querySelector("#st-sound").checked;
    persistSettings(); closeLayer(); render(); toast("설정을 저장했어요");
  });
}

/* ---------- 게임 연출 ---------- */
function typeLines(el,text,done){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches){el.textContent=text;done&&done();return}
  let i=0; const t=setInterval(()=>{el.textContent=text.slice(0,++i); if(i%2===0) tick(); if(i>=text.length){clearInterval(t);done&&done()}},38);
}
function maybeIntro(){
  if(readonly||curDate!==todayStr()||$("#layer").innerHTML) return;
  const key="aq_intro_"+curDate; if(LS.get(key)) return; LS.set(key,1);
  const n=day.stops.length, left=day.stops.filter(s=>!s.done).length;
  const msg = n? `좋은 하루! 아리야.\n오늘 의뢰가 ${n}건 있어. 남은 건 ${left}건!\n같이 출발해 볼까?` : `좋은 하루! 아리야.\n오늘 방문 목록을 받으면\n사진으로 찍어서 올려 줘!`;
  const ov=openLayer(`<div class="term"><div class="t-h"><span>ARISU QUEST</span><span>${curDate.replace(/-/g,".")}</span></div>
    <div class="t-ari ari-bob">${ari(n?"happy":"normal")}</div>
    <div class="typed" id="typed"></div>
    <div class="opts" id="opts" hidden><button class="opt" id="goYes">${n?"응, 출발!":"사진 올리러 가기"}</button><button class="opt" id="goNo">조금 이따가</button></div></div>`);
  typeLines(ov.querySelector("#typed"),msg,()=>{ov.querySelector("#opts").hidden=false;ov.querySelector("#goYes").focus()});
  ov.querySelector("#goYes").onclick=()=>{closeLayer(); blip(); (n?$("#routeOut"):$("#drop")).scrollIntoView({behavior:"smooth",block:"center"})};
  ov.querySelector("#goNo").onclick=closeLayer;
}
function allClear(){
  const ov=openLayer(`<div class="term" style="text-align:center"><div class="t-h"><span>STAGE ${curDate.slice(5).replace("-",".")}</span><span>●${settings.coins}</span></div>
    <div class="t-ari ari-jump">${ari("happy")}</div><div class="clear-banner">ALL CLEAR!</div><div class="typed" id="typed" style="min-height:3rem;margin-top:1rem"></div>
    <div class="opts"><button class="opt" id="ok">고마워 아리!</button></div></div>`);
  typeLines(ov.querySelector("#typed"),`오늘 의뢰 ${day.stops.length}건 모두 끝!\n수고했어, 푹 쉬어 ♥`);
  ov.querySelector("#ok").onclick=closeLayer; fanfare(); burst(null,60);
}
let actx=null;
function tone(f,dur,when=0,type="square",vol=.05){
  if(!settings.sound) return;
  try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    const o=actx.createOscillator(),g=actx.createGain();o.type=type;o.frequency.value=f;g.gain.value=vol;
    o.connect(g);g.connect(actx.destination);const t=actx.currentTime+when;o.start(t);g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(.0001,t+dur);o.stop(t+dur);}catch(e){}
}
function tick(){tone(880,.02,0,"square",.012)}
function blip(){tone(988,.08);tone(1319,.18,.08)}
function fanfare(){[523,659,784,1047,784,1047].forEach((f,i)=>tone(f,.16,i*.12))}
function burst(el,count=18){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const fx=$("#fx"); const r=el?el.getBoundingClientRect():{left:innerWidth/2-50,top:innerHeight/2-50,width:100,height:100};
  const cols=["var(--taxi)","var(--water)","var(--pink)","#FFD66B"];
  for(let i=0;i<count;i++){const p=document.createElement("i");const sz=6+Math.random()*6;
    p.style.cssText=`position:fixed;width:${sz}px;height:${sz}px;background:${cols[i%4]};left:${r.left+r.width/2}px;top:${r.top+r.height/2}px`;
    fx.appendChild(p); const a=Math.random()*Math.PI*2,v=60+Math.random()*140;
    p.animate([{transform:"translate(0,0)",opacity:1},{transform:`translate(${Math.cos(a)*v}px,${Math.sin(a)*v+80}px)`,opacity:0}],{duration:700+Math.random()*400,easing:"steps(10)"}).onfinish=()=>p.remove();}
}

/* ---------- 사진 글자 인식 (기기 안에서, 무료) ---------- */
let photos=[];
function loadScript(src){return new Promise((ok,no)=>{const s=document.createElement("script");s.src=src;s.onload=ok;s.onerror=no;document.head.appendChild(s)})}
async function prepImage(file){
  const img=await createImageBitmap(file);
  const sc=Math.min(2.2, 2400/Math.max(img.width,img.height));
  const c=document.createElement("canvas"); c.width=Math.round(img.width*sc); c.height=Math.round(img.height*sc);
  const x=c.getContext("2d"); x.drawImage(img,0,0,c.width,c.height);
  const d=x.getImageData(0,0,c.width,c.height), p=d.data;
  for(let i=0;i<p.length;i+=4){let g=.299*p[i]+.587*p[i+1]+.114*p[i+2]; g=g<150?Math.max(0,g*0.7):Math.min(255,g*1.15); p[i]=p[i+1]=p[i+2]=g}
  x.putImageData(d,0,0); return c;
}
$("#photo").addEventListener("change",e=>{
  photos=[...e.target.files].slice(0,6); const th=$("#thumbs"); th.innerHTML="";
  photos.forEach(f=>{const im=document.createElement("img");im.alt="올린 사진";im.src=URL.createObjectURL(f);th.appendChild(im)});
  $("#ocrBtn").disabled=!photos.length;
});
$("#ocrBtn").onclick=async()=>{
  if(!photos.length) return; const out=$("#aiOut"); $("#ocrBtn").disabled=true;
  try{
    out.textContent="> 판독기 준비 중... (처음 한 번은 한글 사전을 내려받아요)";
    if(!window.Tesseract) await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
    const worker=await Tesseract.createWorker("kor+eng",1,{logger:m=>{if(m.status==="recognizing text")out.textContent=`> 의뢰서 해독 중 ${Math.round(m.progress*100)}%`}});
    let all="";
    for(let i=0;i<photos.length;i++){ out.textContent=`> 사진 ${i+1}/${photos.length} 해독 중`; const c=await prepImage(photos[i]); const {data}=await worker.recognize(c); all+=data.text+"\n"; }
    await worker.terminate();
    out.textContent="> 해독 완료. 내용을 확인해 주세요";
    reviewRows(parseText(all), all);
  }catch(e){ out.textContent="> 사진을 읽지 못했어요. 글로 붙여넣거나 직접 추가해 주세요"; }
  finally{ $("#ocrBtn").disabled=false; }
};
$("#parseBtn").onclick=()=>{
  const t=$("#pasteBox").value.trim(); if(!t){toast("붙여넣은 글이 없어요");return}
  reviewRows(parseText(t), t);
};
const PHONE=/(\(?0\d{1,2}\)?[-.\s]?\d{3,4}[-.\s]?\d{4})/g;
const ADDR=/((?:서울(?:특별시|시)?\s*)?[가-힣]{1,4}구\s+[가-힣0-9][^\n]{1,80})/;
const HEADER=/^(번호|순번|no\.?|장소|주소|비고|연번|검사|구분)(\s|$)/i;
function parseText(text){
  const lines=String(text).replace(PHONE,"").split(/\n/).map(l=>l.replace(/[|｜_]+/g," ").replace(/\s{2,}/g," ").trim()).filter(l=>l.length>1&&!HEADER.test(l));
  const rows=[]; let pendingName="";
  for(const l of lines){
    const m=l.match(ADDR);
    if(m){
      let name=l.slice(0,m.index).replace(/^\s*\d{1,3}[.)\s]*/,"").trim();
      if(!name&&pendingName) name=pendingName;
      let addr=m[1].trim().replace(/\s*(검사|채수|비고).*$/,"");
      if(!/^서울/.test(addr)) addr="서울 "+addr;
      rows.push({name:name||"이름 확인 필요",addr}); pendingName="";
    } else pendingName=l.replace(/^\s*\d{1,3}[.)\s]*/,"").slice(0,40);
  }
  return rows;
}
function reviewRows(rows, raw){
  const rowHtml=(r,i)=>`<div class="rv" data-i="${i}" style="display:grid;gap:.3rem;border:2px solid var(--line);padding:.5rem">
     <input class="inp" data-f="name" value="${esc(r.name)}" aria-label="장소명">
     <input class="inp" data-f="addr" value="${esc(r.addr)}" aria-label="주소">
     <label class="small" style="flex-direction:row;display:flex;gap:.4rem;align-items:center"><input type="checkbox" data-f="skip"> 이 줄 빼기</label></div>`;
  const ov=openLayer(`<div class="px sheet"><div class="px-h"><h2>읽은 목록 확인</h2><span class="tag">${rows.length} FOUND</span></div>
    <p class="small muted" style="margin:0">자동으로 읽은 결과라 틀릴 수 있어요. 고칠 곳을 고친 뒤 추가해 주세요.</p>
    <div id="rvList" style="display:flex;flex-direction:column;gap:.5rem">${rows.length?rows.map(rowHtml).join(""):'<p class="need">주소를 찾지 못했어요. 아래 원문을 보고 직접 추가해 주세요.</p>'}</div>
    <button class="btn sm" id="rvAdd" type="button">빈 줄 추가</button>
    <details><summary class="small">읽은 원문 보기</summary><textarea readonly style="min-height:10rem">${esc(raw)}</textarea></details>
    <div class="row"><button class="btn y" id="rvOk">목록에 추가</button><button class="btn" id="rvNo">취소</button></div></div>`);
  let n=rows.length;
  ov.querySelector("#rvAdd").onclick=()=>{ov.querySelector("#rvList").insertAdjacentHTML("beforeend",rowHtml({name:"",addr:""},n++))};
  ov.querySelector("#rvNo").onclick=closeLayer;
  ov.querySelector("#rvOk").onclick=()=>{
    const out=[...ov.querySelectorAll(".rv")].filter(d=>!d.querySelector('[data-f="skip"]').checked).map(d=>({
      id:uidGen(),name:d.querySelector('[data-f="name"]').value.trim(),addr:d.querySelector('[data-f="addr"]').value.trim(),gu:"",dong:"",lat:null,lng:null,note:"",done:false})).filter(r=>r.name||r.addr);
    closeLayer(); addRows(out); $("#pasteBox").value="";
  };
}
function addRows(rows){
  if(!rows.length){toast("추가할 장소가 없어요");return}
  if(day.stops.length+rows.length>80){limitAlert("하루 목록은 80곳까지 저장할 수 있어요.");return}
  day.stops=day.stops.filter(s=>!s.example);
  rows.forEach((r,i)=>r.order=day.stops.length+i); day.stops.push(...rows); day.routed=false;
  planRoute(); persistDay(); render(); blip();
  toast(`의뢰 ${rows.length}건 접수. 좌표를 찾는 중이에요`);
  showIntake(false);
  $("#routeOut").scrollIntoView({behavior:"smooth",block:"start"});
  geocodeStops(rows);
}
$("#manualBtn").onclick=()=>editStop(null,true);

/* ---------- 의뢰 접수 페이지 ---------- */
function showIntake(on){
  $("#app").hidden=on; $("#intakePage").hidden=!on;
  if(on){ const d=new Date(curDate+"T12:00:00"); $("#intakeDate").textContent=`${d.getMonth()+1}/${d.getDate()} ${WD[d.getDay()]}`; }
  window.scrollTo(0,0);
}
$("#intakeBtn").onclick=()=>showIntake(true);
$("#intakeBack").onclick=()=>showIntake(false);

/* ---------- 무료 지도(OpenStreetMap)로 좌표·행정동 찾기 ---------- */
// Nominatim 이용 정책: 초당 1건 이하, 결과는 기기에 저장해 다시 묻지 않음
let geoBusy=Promise.resolve();
function cleanAddr(a){return String(a||"").replace(/\(.*?\)/g," ").replace(/,.*$/,"").replace(/\s\d+층.*$/,"").replace(/\s{2,}/g," ").trim()}
function geocode(addr){
  const q=cleanAddr(addr); if(!q) return Promise.resolve(null);
  const ck="aq_geo_"+q; const hit=LS.get(ck); if(hit) return Promise.resolve(hit);
  const job=geoBusy.then(async()=>{
    await new Promise(r=>setTimeout(r,1100));
    try{
      const u="https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&countrycodes=kr&accept-language=ko&q="+encodeURIComponent(q);
      const res=await fetch(u,{headers:{"Accept":"application/json"}}); if(!res.ok) return null;
      const j=await res.json(); if(!j[0]) return null;
      const a=j[0].address||{};
      const gu=[a.borough,a.city_district,a.county].find(x=>x&&/구$/.test(x))||"";
      const dong=[a.quarter,a.suburb,a.neighbourhood,a.village].find(x=>x&&/동$/.test(x))||"";
      const r={lat:+(+j[0].lat).toFixed(6),lng:+(+j[0].lon).toFixed(6),gu,dong};
      LS.set(ck,r); return r;
    }catch(e){return null}
  });
  geoBusy=job.catch(()=>null); return job;
}
async function geocodeStops(list){
  const need=list.filter(s=>!hasXY(s)||!s.dong||!guOf(s)); if(!need.length) return 0;
  let c=0;
  for(const s of need){
    const r=await geocode(s.addr); if(!r) continue;
    if(!hasXY(s)){s.lat=r.lat;s.lng=r.lng;s.xyEst=true;c++}
    if(!s.gu&&r.gu){s.gu=r.gu} if(!s.dong&&r.dong){s.dong=r.dong;s.dongSure=false}
  }
  if(c){ planRoute(); persistDay(); render(); }
  return c;
}
$("#fillBtn").onclick=async()=>{
  const need=day.stops.filter(s=>!hasXY(s)||!s.dong||!guOf(s));
  if(!need.length){toast("찾을 정보가 없어요");return}
  toast(`${need.length}곳을 찾는 중이에요 (한 곳에 1초쯤)`);
  const c=await geocodeStops(need);
  toast(c?`${c}곳의 좌표를 찾았어요 (추정값)`:"찾지 못했어요. 도로명 주소로 고쳐 보세요");
};

/* ---------- 공유 ---------- */
function shareText(){
  const d=new Date(curDate+"T12:00:00");
  const stops=[...day.stops].sort((a,b)=>(a.order??0)-(b.order??0));
  let t=`[아리수 퀘스트] ${d.getMonth()+1}/${d.getDate()}(${WD[d.getDay()]}) 방문 ${stops.length}곳 · 완료 ${stops.filter(s=>s.done).length}곳\n`;
  let lastOff=null;
  stops.forEach((s,i)=>{const off=officeOf(s)||"관할 미지정"; if(off!==lastOff){t+=`\n■ ${off.replace(" [확인 필요]","")}\n`;lastOff=off}
    t+=`${s.done?"☑":"☐"} ${i+1}. ${s.name}${guOf(s)?` (${guOf(s)}${s.dong?" "+s.dong:""})`:""}\n   ${s.addr||""}\n`});
  return t;
}
async function ensureShareLink(){
  if(!sb||!user) return null;
  if(!shareToken){
    const a=new Uint8Array(18); crypto.getRandomValues(a);
    const tok=[...a].map(b=>b.toString(36).padStart(2,"0")).join("").slice(0,28);
    await saving;
    const {error}=await sb.from("days").upsert({user_id:user.id,date:curDate,data:day,share_token:tok},{onConflict:"user_id,date",returning:"minimal"});
    if(error){dbError(error);return null}
    shareToken=tok;
  }
  return location.origin+location.pathname+"#s="+shareToken;
}
$("#shareBtn").onclick=async()=>{
  if(readonly){ copyBox(shareText(), location.href); return; }
  const link=await ensureShareLink();
  const txt=shareText()+(link?`\n보기 전용 링크: ${link}\n`:"");
  if(navigator.share){ try{ await navigator.share({title:"아리수 퀘스트",text:txt}); return; }catch(e){ if(e&&e.name==="AbortError") return; } }
  copyBox(txt, link);
};
function copyBox(txt, link){
  const ov=openLayer(`<div class="px sheet"><div class="px-h"><h2>공유하기</h2><span class="tag">SHARE</span></div>
    <p class="small muted" style="margin:0">카톡·문자에 붙여넣으세요. 링크를 받은 사람은 로그인 없이 이 날 목록을 볼 수만 있어요.</p>
    <textarea id="shareTxt" readonly style="min-height:14rem">${esc(txt)}</textarea>
    <div class="row"><button class="btn y" id="copyBtn">복사하기</button>${link&&!readonly?'<button class="btn sm ghost" id="unshare">링크 끄기</button>':""}<button class="btn" id="shClose">닫기</button></div></div>`);
  ov.querySelector("#shClose").onclick=closeLayer;
  ov.querySelector("#copyBtn").onclick=()=>{const ta=ov.querySelector("#shareTxt");
    navigator.clipboard.writeText(txt).then(()=>toast("복사했어요"),()=>{ta.focus();ta.select();toast("선택된 글을 길게 눌러 복사해 주세요")})};
  const un=ov.querySelector("#unshare"); if(un) un.onclick=async()=>{const {error}=await sb.from("days").update({share_token:null}).eq("date",curDate); if(error) return dbError(error); shareToken=null; closeLayer(); toast("공유 링크를 껐어요")};
}

/* ---------- 예시 ---------- */
function loadDemo(){
  const ex={example:true,xyEst:true};
  day.stops=[
    {id:uidGen(),name:"예시 장소 A",addr:"[예시] 서울 강서구 화곡동",gu:"강서구",dong:"",lat:37.5413,lng:126.8400,note:"예시 데이터입니다",...ex},
    {id:uidGen(),name:"예시 장소 B",addr:"[예시] 서울 양천구 신정동",gu:"양천구",dong:"",lat:37.5170,lng:126.8664,note:"예시 데이터입니다",...ex},
    {id:uidGen(),name:"예시 장소 C",addr:"[예시] 서울 구로구 구로동",gu:"구로구",dong:"",lat:37.4954,lng:126.8874,note:"예시 데이터입니다",...ex},
  ];
  planRoute(); render(); toast("예시를 불러왔어요. 목록을 추가하면 예시는 사라져요");
}

/* ---------- 사용량 알림 ---------- */
async function checkUsage(show){
  if(!sb||!user) return;
  const {data,error}=await sb.rpc("usage_status");
  if(error||!data){ if(show) toast("사용량을 불러오지 못했어요"); return; }
  const db=data.db_bytes/data.db_limit, mau=data.users/data.mau_limit;
  const lines=[`DB 저장 공간 ${(data.db_bytes/1048576).toFixed(1)}MB / 500MB (${Math.round(db*100)}%)`,`가입자 ${data.users}명 / 월 활성 50,000명`];
  const warn=[]; if(db>=WARN_AT) warn.push(`DB 저장 공간이 ${Math.round(db*100)}% 찼어요`); if(mau>=WARN_AT) warn.push(`가입자가 무료 한도의 ${Math.round(mau*100)}%예요`);
  if(warn.length){
    const key="aq_warn_"+todayStr();
    if(show||!LS.get(key)){ LS.set(key,1); limitAlert(warn.join(" / ")+". 오래된 기록을 지우거나 유료 플랜을 검토해 주세요."); }
    else { const b=$("#limitBanner"); b.hidden=false; b.innerHTML=`<strong>사용량 알림</strong><div>${esc(warn.join(" / "))}</div>`; }
  } else if(show){
    const ov=openLayer(`<div class="px sheet"><div class="px-h"><h2>서버 사용량</h2><span class="tag">FREE PLAN</span></div>
      ${lines.map(l=>`<div>${esc(l)}</div>`).join("")}
      <p class="src" style="margin:0">데이터 전송량(월 5GB)은 Supabase 대시보드에서만 확인돼요 [확인 필요]. 80%가 넘으면 이 앱이 알려 드려요.</p>
      <div class="row"><button class="btn" id="uClose">닫기</button></div></div>`);
    ov.querySelector("#uClose").onclick=closeLayer;
  }
}

/* ---------- 로그인 ---------- */
function idOf(u){return String(u.email||"")}
function authScreen(msg, mode){
  mode = mode||"in";
  const up = mode==="up";
  const inStyle="";
  const ov=openLayer(`<form class="term" id="authForm" autocomplete="on"><div class="t-h"><span>ARISU QUEST</span><span>${up?"NEW AGENT":"LOGIN"}</span></div>
    <div class="auth-tabs" role="tablist">
      <button type="button" role="tab" class="auth-tab ${up?"":"on"}" aria-selected="${!up}" id="tabIn">로그인</button>
      <button type="button" role="tab" class="auth-tab ${up?"on":""}" aria-selected="${up}" id="tabUp">회원가입</button>
    </div>
    <div class="t-ari ari-bob">${ari(up?"happy":"normal")}</div>
    <div class="typed" id="typed" style="min-height:3.2rem"></div>
    <div class="opts">
      <label class="small" for="au-id">이메일</label>
      <input class="inp" id="au-id" type="email" inputmode="email" autocomplete="email" autocapitalize="off" required ${inStyle}>
      <label class="small" for="au-pw">비밀번호${up?" (6자 이상)":""}</label>
      <input class="inp" id="au-pw" type="password" autocomplete="${up?"new-password":"current-password"}" required minlength="6" ${inStyle}>
      ${up?`<label class="small" for="au-pw2">비밀번호 한 번 더</label>
      <input class="inp" id="au-pw2" type="password" autocomplete="new-password" required minlength="6" ${inStyle}>`:""}
      <div class="small" id="au-msg" style="min-height:1.2rem">${esc(msg||"")}</div>
      <button class="opt auth-go" type="submit">${up?"가입하고 시작하기":"로그인"}</button>
      <button class="auth-link" type="button" id="au-switch">${up?"이미 계정이 있어요 · 로그인":"처음이세요? 회원가입"}</button>
    </div></form>`, true);
  typeLines(ov.querySelector("#typed"), up?"반가워! 나는 아리야.\n쓰는 이메일로 가입해 줘.":"다시 왔구나! 아리야.\n이메일로 로그인해 줘.");
  const sw=()=>authScreen("", up?"in":"up");
  ov.querySelector("#au-switch").onclick=sw;
  ov.querySelector(up?"#tabIn":"#tabUp").onclick=sw;
  ov.querySelector("#authForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const email=ov.querySelector("#au-id").value.trim().toLowerCase(), pw=ov.querySelector("#au-pw").value;
    const msgEl=ov.querySelector("#au-msg");
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){msgEl.textContent="이메일 주소를 정확히 넣어 주세요";return}
    if(pw.length<6){msgEl.textContent="비밀번호는 6자 이상이에요";return}
    if(up&&pw!==ov.querySelector("#au-pw2").value){msgEl.textContent="비밀번호 두 개가 서로 달라요";return}
    msgEl.textContent= up?"등록 중...":"확인 중...";
    const r = up ? await sb.auth.signUp({email,password:pw}) : await sb.auth.signInWithPassword({email,password:pw});
    if(r.error){
      const m=r.error.message||"";
      msgEl.textContent = /already|registered/i.test(m)?"이미 가입된 이메일이에요. 로그인 탭에서 들어가 주세요"
        : /Invalid login/i.test(m)?"이메일이나 비밀번호가 맞지 않아요"
        : /not confirmed/i.test(m)?"이메일 확인이 켜져 있어요. 관리자에게 알려 주세요"
        : /invalid/i.test(m)?"이 이메일 주소는 쓸 수 없어요. 실제 쓰는 이메일로 넣어 주세요"
        : /rate|limit|429/i.test(m)?"요청이 많아요. 잠시 후 다시 시도해 주세요"
        : (up?"가입하지 못했어요: ":"로그인하지 못했어요: ")+m;
      return;
    }
    if(up&&!r.data.session){msgEl.textContent="가입은 됐지만 이메일 확인이 켜져 있어요. 관리자에게 알려 주세요";return}
    closeLayer(); if(up) toast("가입을 환영해요!"); await afterLogin(r.data.session.user);
  });
}
async function afterLogin(u){
  user=u;
  const {data}=await sb.from("settings").select("data").maybeSingle();
  if(data&&data.data) settings=Object.assign(settings,data.data);
  else persistSettings();
  LS.set("aq_settings",settings);
  await loadDay(curDate);
  checkUsage(false);
}

/* ---------- 공유받은 화면 ---------- */
async function openShared(tok){
  readonly=true;
  document.body.classList.add("readonly");
  $("#intakeBtn").hidden=true; $("#routeBtn").hidden=true; $("#fillBtn").hidden=true; $("#clearDay").hidden=true;
  $("#prevDay").hidden=true; $("#nextDay").hidden=true; $("#todayBtn").hidden=true; $("#datePick").hidden=true; $("#setBtn").hidden=true;
  const b=$("#sharedBanner"); b.hidden=false; b.innerHTML=`<strong>공유받은 목록이에요</strong><div class="small">보기만 할 수 있어요. 내 일정을 관리하려면 <a href="${location.pathname}">여기서 로그인</a>하세요.</div>`;
  const {data,error}=await sb.rpc("get_shared_day",{p_token:tok});
  if(error||!data||!data.length){ b.innerHTML="<strong>공유 링크가 꺼졌거나 잘못됐어요.</strong>"; render(); return; }
  curDate=String(data[0].date); day=Object.assign(emptyDay(curDate), data[0].data); render();
}

/* ---------- 상단 버튼 ---------- */
$("#ariBtn").onclick=()=>{ tone(1047,.08); tone(1319,.12,.08); ariJump(CHEERS[Math.floor(Math.random()*CHEERS.length)]); };
$("#fontUp").onclick=()=>{settings.scale=Math.min(1.7,+(settings.scale+.1).toFixed(2));persistSettings();render()};
$("#fontDown").onclick=()=>{settings.scale=Math.max(.9,+(settings.scale-.1).toFixed(2));persistSettings();render()};
$("#themeBtn").onclick=()=>{settings.theme=isDark()?"light":"dark";persistSettings();render()};
$("#setBtn").onclick=openSettings;
$("#prevDay").onclick=()=>loadDay(shiftDate(curDate,-1));
$("#nextDay").onclick=()=>loadDay(shiftDate(curDate,1));
$("#todayBtn").onclick=()=>loadDay(todayStr());
$("#datePick").onchange=e=>e.target.value&&loadDay(e.target.value);
$("#routeBtn").onclick=()=>{ if(!day.stops.length){toast("먼저 의뢰를 접수해 주세요");return} planRoute(); persistDay(); render(); blip(); toast("수도사업소별로 동선을 짰어요"); };
$("#clearDay").onclick=()=>{ if(!day.stops.length) return; confirmBox("이 날 목록을 모두 지울까요?",()=>{day=emptyDay(curDate);persistDay();render()}) };
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change",()=>render());

/* ---------- 시작 ---------- */
(async()=>{
  render();
  if(!sb){ $("#limitBanner").hidden=false; $("#limitBanner").textContent="서버 설정이 없어 이 기기에만 저장돼요."; return; }
  const tok=(location.hash.match(/^#s=([A-Za-z0-9]{20,64})$/)||[])[1];
  if(tok) return openShared(tok);
  const {data}=await sb.auth.getSession();
  if(data.session) await afterLogin(data.session.user); else authScreen();
})();
})();
