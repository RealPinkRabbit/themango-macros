// ==UserScript==
// @name         더망고 상품수집 자동 반복 (엑셀 연동) v3
// @namespace    solddeul.tmg
// @version      3.0
// @description  엑셀(.xlsx)에서 필터/URL을 직접 읽어 더망고 신규상품 수집을 순차 자동 등록. 하드코딩 없이 엑셀만 수정하면 됨. URL검색이 페이지를 리로드하므로 phase(search/save)를 저장해 로드에 걸쳐 진행하고, 완료 로그로 판정.
// @match        https://tmg4682.mycafe24.com/mall/admin/shop/getGoods.php*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
'use strict';

var LS_RUN='tmg_auto_v3';       // 실행 상태(진행중/phase/index)
var LS_DATA='tmg_data_v3';      // 엑셀에서 불러온 데이터

var SITE_LABEL={a_rt:'ABC마트', zara_de:'독일자라', zara_kr:'자라KR', musinsa:'무신사', ebay:'eBay'};
var LABEL_TO_CODE={'ABC마트':'a_rt','독일자라':'zara_de','자라KR':'zara_kr','ZaraKR':'zara_kr','Zara KR':'zara_kr','무신사':'musinsa','MUSINSA':'musinsa','eBay':'ebay','ebay':'ebay'};

function gs(){ try{return JSON.parse(localStorage.getItem(LS_RUN))||{};}catch(e){return {};} }
function ss(s){ localStorage.setItem(LS_RUN, JSON.stringify(s)); }
function loadData(){ try{return JSON.parse(localStorage.getItem(LS_DATA))||{};}catch(e){return {};} }
function saveData(d){ localStorage.setItem(LS_DATA, JSON.stringify(d)); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function q(s){ return document.querySelector(s); }
function txt(){ return document.body.innerText||''; }
function curTab(){ var m=location.search.match(/tab_type=([a-z_]+)/); return m?m[1]:''; }
function aByText(t){ return Array.prototype.slice.call(document.querySelectorAll('a')).find(function(e){return e.textContent.trim().indexOf(t)>=0;}); }
function st_msg(m){ var st=q('#tmgStat'); if(st) st.textContent=m; }
function nav(site){ location.href='getGoods.php?tab_type='+site+'&_ts='+Date.now(); }
function doSearch(){ if(typeof set_search_extension==='function'){ set_search_extension('1'); } else { var b=q('a.defbtn_med.dtype2'); if(b) b.click(); } }
function codeLabel(c){ return SITE_LABEL[c]||c; }

async function waitFor(cond, timeout, interval, label){
  timeout=timeout||240000; interval=interval||1500; var t0=Date.now();
  while(Date.now()-t0<timeout){ var v=false; try{ v=cond(); }catch(e){} if(v) return true; await sleep(interval); }
  throw new Error('시간초과: '+(label||''));
}
async function fetchExisting(){
  try{
    var html=await fetch('/mall/admin/shop/getGoodsCategory.php',{credentials:'same-origin'}).then(function(r){return r.text();});
    var doc=new DOMParser().parseFromString(html,'text/html');
    return Array.prototype.slice.call(doc.querySelectorAll('input')).map(function(i){return (i.value||'').trim();}).filter(function(v){return v && v.indexOf('-')>=0;});
  }catch(e){ return []; }
}

// ---------- 엑셀 파싱 ----------
function cellVal(ws,addr){ var c=ws[addr]; if(!c) return ''; return (c.v!==undefined && c.v!==null)?c.v:(c.w!==undefined?c.w:''); }
function siteCode(label,url){
  var L=(label||'').trim();
  if(LABEL_TO_CODE[L]) return LABEL_TO_CODE[L];
  url=String(url||'');
  if(url.indexOf('abcmart')>=0) return 'a_rt';
  if(/zara\.com\/de/.test(url)) return 'zara_de';
  if(/zara\.com\/kr/.test(url)) return 'zara_kr';
  if(url.indexOf('musinsa')>=0) return 'musinsa';
  if(url.indexOf('ebay')>=0) return 'ebay';
  return null;
}
function parseWorkbook(wb){
  var data={}, meta={};
  wb.SheetNames.forEach(function(nm){
    if(nm.indexOf('원본')>=0) return;              // 예시 시트 제외
    var ws=wb.Sheets[nm]; if(!ws) return;
    var biz=String(cellVal(ws,'H3')||'').trim();
    var site=String(cellVal(ws,'I3')||'').trim();
    if(!site) return;
    for(var r=3;r<5000;r++){
      var b=String(cellVal(ws,'B'+r)||'').trim();
      var u=String(cellVal(ws,'D'+r)||'').trim();
      if(!b) break;
      if(u.slice(0,4)!=='http') continue;
      var code=siteCode(site,u); if(!code) continue;
      var name=(biz?biz+'-':'')+site+'-'+b;         // 엑셀 C열 수식과 동일: 사업자명-사이트-카테고리
      (data[code]=data[code]||[]).push({name:name,url:u});
      if(!meta[code]) meta[code]={label:codeLabel(code), site:site, biz:biz, count:0};
      meta[code].count++;
    }
  });
  return {data:data, meta:meta};
}
function handleFile(file){
  var reader=new FileReader();
  reader.onload=function(e){
    try{
      var wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'});
      var parsed=parseWorkbook(wb);
      var codes=Object.keys(parsed.data);
      if(!codes.length){ alert('엑셀에서 유효한 행을 찾지 못했습니다.\n각 탭의 사업자명(H3)·수집사이트(I3)·카테고리(B)·URL(D)을 확인하세요.'); return; }
      saveData(parsed.data);
      localStorage.setItem('tmg_meta_v3', JSON.stringify(parsed.meta));
      var lines=codes.map(function(c){ var m=parsed.meta[c]; return m.label+'('+(m.biz||'사업자명없음')+'): '+m.count+'행'; });
      alert('불러오기 완료\n'+lines.join('\n'));
      renderButtons();
    }catch(err){ alert('엑셀 파싱 실패: '+(err&&err.message||err)); }
  };
  reader.readAsArrayBuffer(file);
}

// ---------- 패널 ----------
function ui(){
  if(q('#tmgPanel')){ render(); renderButtons(); return; }
  var p=document.createElement('div'); p.id='tmgPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #d9534f;border-radius:8px;padding:10px 12px;width:260px;font:12px/1.5 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold;margin-bottom:6px">더망고 자동수집 v3 (엑셀연동)</div>'
   +'<div id="tmgStat" style="margin-bottom:8px;color:#333;min-height:20px"></div>'
   +'<button id="tmgLoad">엑셀 불러오기(.xlsx)</button>'
   +'<input type="file" id="tmgFile" accept=".xlsx" style="display:none">'
   +'<div id="tmgSites" style="margin:8px 0"></div>'
   +'<div style="margin-bottom:6px"><label><input type="checkbox" id="tmgSkip" checked> 기존 필터 건너뛰기</label></div>'
   +'<button id="tmgResume">이어서</button> '
   +'<button id="tmgStop" style="color:#d9534f">정지</button>';
  document.body.appendChild(p);
  q('#tmgLoad').onclick=function(){ q('#tmgFile').click(); };
  q('#tmgFile').onchange=function(e){ if(e.target.files&&e.target.files[0]) handleFile(e.target.files[0]); };
  q('#tmgResume').onclick=function(){ resume(); };
  q('#tmgStop').onclick=function(){ var s=gs(); s.running=false; ss(s); render(); alert('정지했습니다.'); };
  render(); renderButtons();
}
function renderButtons(){
  var box=q('#tmgSites'); if(!box) return;
  var data=loadData(); var codes=Object.keys(data);
  if(!codes.length){ box.innerHTML='<span style="color:#888">엑셀을 먼저 불러오세요.</span>'; return; }
  box.innerHTML=codes.map(function(c){ return '<button data-code="'+c+'" class="tmgStart" style="margin:2px 4px 2px 0">'+codeLabel(c)+' 시작 ('+data[c].length+')</button>'; }).join('');
  Array.prototype.slice.call(box.querySelectorAll('.tmgStart')).forEach(function(btn){ btn.onclick=function(){ start(btn.getAttribute('data-code')); }; });
}
function render(){
  var st=q('#tmgStat'); if(!st) return; var s=gs();
  if(s.running && s.site){
    var d=loadData(); var tot=d[s.site]?d[s.site].length:0;
    st.innerHTML='실행중: <b>'+codeLabel(s.site)+'</b> ('+(s.phase||'search')+')<br>진행 '+(s.index||0)+' / '+tot+'<br><span style="color:#888;font-size:11px">'+(s.last||'')+'</span>';
  } else if(s.error){ st.innerHTML='<span style="color:#d9534f">중단됨<br>'+(s.last||'')+'<br>'+s.error+'</span>'; }
  else if(s.done){ st.textContent='완료: '+codeLabel(s.site||''); }
  else { st.textContent='대기중'; }
}

// ---------- 실행 ----------
async function start(site){
  var data=loadData(); var rows=data[site]||[];
  if(!rows.length){ alert('데이터 없음: '+codeLabel(site)+'\n엑셀을 먼저 불러오세요.'); return; }
  var skip=q('#tmgSkip') && q('#tmgSkip').checked;
  var existing=[]; if(skip){ st_msg('기존 필터 확인 중...'); existing=await fetchExisting(); }
  ss({running:true, site:site, index:0, phase:'search', skip:skip, existing:existing, last:'', error:'', done:false});
  nav(site);
}
async function resume(){
  var s=gs(); if(!s.site){ alert('이어서 할 작업이 없습니다.'); return; }
  var skip=q('#tmgSkip') && q('#tmgSkip').checked;
  var existing=[]; if(skip){ st_msg('기존 필터 확인 중...'); existing=await fetchExisting(); }
  s.running=true; s.error=''; s.phase='search'; s.skip=skip; s.existing=existing; ss(s);
  nav(s.site);
}

async function loop(){
  if(window.__tmgBusy) return; window.__tmgBusy=true;
  try{
    ui(); var s=gs();
    if(!s.running || !s.site){ render(); return; }
    var data=loadData(); var rows=data[s.site]||[]; var site=s.site;
    if(!rows.length){ s.running=false; s.error='데이터 없음(엑셀 재로드 필요)'; ss(s); render(); return; }
    if(curTab()!==site){ nav(site); return; }

    if(s.phase!=='save'){
      // ===== SEARCH phase (clean page) =====
      var existing=s.existing||[];
      while(s.index<rows.length && s.skip && existing.indexOf(rows[s.index].name)>=0){ s.index++; }
      if(s.index>=rows.length){ s.running=false; s.done=true; ss(s); render(); alert(codeLabel(site)+' 전체 완료 ('+rows.length+'행)'); return; }
      var row=rows[s.index];
      s.phase='save'; s.last='['+(s.index+1)+'/'+rows.length+'] '+row.name; ss(s); render();
      await sleep(500);
      var urlIn=q('input[name="search_url"]'); if(!urlIn) throw new Error('URL 입력창을 찾지 못함');
      urlIn.value=row.url;
      doSearch();   // 리로드 -> 결과 페이지에서 save phase 재진입
      return;
    }

    // ===== SAVE phase (results page) =====
    var row2=rows[s.index];
    if(!row2){ s.phase='search'; ss(s); nav(site); return; }
    s.last='['+(s.index+1)+'/'+rows.length+'] '+row2.name; ss(s); render();
    var ok=false;
    try{ await waitFor(function(){ var t=txt(); return !/불러오는|load\s*product/i.test(t) && /상품번호\s*:/.test(t); }, 90000, 1500, '검색결과 로딩'); ok=true; }
    catch(e){ ok=/상품번호\s*:/.test(txt()); }
    if(!ok){ s.index++; s.phase='search'; s.last=row2.name+' (상품없음, 건너뜀)'; ss(s); render(); await sleep(500); nav(site); return; }
    await sleep(900);
    var saveAll=q('#abcdd')||aByText('검색된 상품 모두저장'); if(!saveAll) throw new Error('모두저장 버튼을 찾지 못함');
    saveAll.click();
    await waitFor(function(){ var f=q('#filter_name'); return f && f.offsetParent!==null; }, 20000, 500, '저장 팝업');
    q('#filter_name').value=row2.name;
    var lc=q('#limit_count'); if(lc) lc.value='3';
    await sleep(400);
    var saveBtn=q('.btn-layerSave')||aByText('저장하기'); if(!saveBtn) throw new Error('저장하기 버튼을 찾지 못함');
    saveBtn.click();
    await waitFor(function(){ return txt().indexOf('저장이 완료되었습니다')>=0; }, 300000, 2000, '저장 완료 로그');
    await sleep(1200);
    var s2=gs(); s2.index=(s2.index||0)+1; s2.phase='search'; s2.last=row2.name+' 완료'; ss(s2); render();
    await sleep(400);
    nav(site);
  }catch(err){
    var s3=gs(); s3.running=false; s3.error=(err&&err.message)||String(err); ss(s3); render();
    alert('중단됨\n'+s3.error+'\n\n수동 확인 후 "이어서" 버튼으로 재개하세요.');
  }finally{
    window.__tmgBusy=false;
  }
}

function boot(){
  try{ localStorage.removeItem('tmg_auto_v1'); localStorage.removeItem('tmg_auto_v2'); }catch(e){}
  ui();
  var s=gs(); if(s.running){ setTimeout(loop, 1800); }
}
if(document.readyState==='complete') boot(); else window.addEventListener('load', boot);
})();
