// ==UserScript==
// @name         더망고 신규상품수집 - 저장상품수 일괄변경
// @namespace    solddeul.tmg
// @version      1.1
// @description  신규상품수집 목록의 모든 필터에 대해 "저장상품수(limit_count)"를 지정값(기본 100)으로 일괄 변경. 팝업/새로고침 없이 fetch로 수정폼을 읽어 limit_count만 바꿔 저장(다른 설정 보존).
// @match        https://tmg4682.mycafe24.com/mall/admin/shop/getGoodsCategory.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
'use strict';

var DIR = location.pathname.replace(/[^/]+$/,'');            // /mall/admin/shop/
var LIST_URL = DIR + 'getGoodsCategory.php';
var stop=false;

function q(s){ return document.querySelector(s); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }

// modify_filter 내부 window.open URL을 가로채 필터별 수정폼 URL을 얻음(하드코딩 없음)
function editUrl(id){
  var cap=null, o=window.open;
  window.open=function(u){ cap=u; return {closed:false,close:function(){},focus:function(){},document:{}}; };
  try{ if(typeof modify_filter==='function') modify_filter(String(id)); }catch(e){}
  window.open=o;
  return cap ? new URL(cap, location.href).href : null;   // 절대경로로
}
// 수정폼의 모든 필드를 그대로 수집(정적 파싱=렌더값과 동일함을 확인함)
function collectForm(form){
  var p=new URLSearchParams();
  Array.prototype.slice.call(form.querySelectorAll('input,select,textarea')).forEach(function(el){
    var name=el.getAttribute('name'); if(!name) return;
    var tag=el.tagName, type=(el.getAttribute('type')||'').toLowerCase();
    if(tag==='INPUT'&&(type==='checkbox'||type==='radio')){ if(el.hasAttribute('checked')) p.append(name, el.getAttribute('value')||'on'); return; }
    if(tag==='SELECT'){ var op=el.querySelector('option[selected]')||el.querySelector('option'); p.append(name, op?(op.getAttribute('value')||''):''); return; }
    p.append(name, el.getAttribute('value')!=null?el.getAttribute('value'):(el.value||''));
  });
  return p;
}

async function enumerateIds(siteId){
  var ids=[];
  for(var pg=1; pg<200; pg++){
    var url=LIST_URL+'?ft_num=100&pg='+pg+(siteId?'&site_id='+siteId:'');
    var html=await fetch(url,{credentials:'same-origin'}).then(function(r){return r.text();});
    var m=(html.match(/modify_filter\('(\d+)'\)/g)||[]).map(function(s){return s.match(/\d+/)[0];});
    if(!m.length) break;
    m.forEach(function(x){ if(ids.indexOf(x)<0) ids.push(x); });
    if(m.length<100) break;
  }
  return ids;
}

async function updateOne(id, target){
  var euAbs=editUrl(id); if(!euAbs) throw new Error('수정 URL 획득 실패');
  var html=await fetch(euAbs,{credentials:'same-origin'}).then(function(r){return r.text();});
  var doc=new DOMParser().parseFromString(html,'text/html');
  var form=doc.querySelector('form'); if(!form) throw new Error('수정폼 없음');
  var p=collectForm(form);
  var cur=p.get('limit_count');
  if(cur===String(target)) return 'skip';
  p.set('limit_count', String(target));
  var okAbs=new URL(form.getAttribute('action')||'admin_etc_ok.php', euAbs).href;  // 수정폼 기준 저장 endpoint
  var resp=await fetch(okAbs,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:p.toString()});
  if(resp.status!==200) throw new Error('HTTP '+resp.status);
  var rt=await resp.text();
  if(/오류|실패|error/i.test(rt) && !/완료|성공|success/i.test(rt)) throw new Error('저장 응답 오류');
  return 'ok';
}

async function run(){
  var target=parseInt((q('#tmgTarget')&&q('#tmgTarget').value)||'100',10);
  if(!(target>0)){ alert('저장상품수를 올바르게 입력하세요.'); return; }
  var siteId=(q('#tmgSite')&&q('#tmgSite').value)||'';
  stop=false; setBtn(true);
  set('필터 목록 수집 중...');
  var ids;
  try{ ids=await enumerateIds(siteId); }catch(e){ set('목록 수집 실패: '+e.message); setBtn(false); return; }
  if(!ids.length){ set('대상 필터가 없습니다.'); setBtn(false); return; }
  var ok=0, skip=0, fail=0, fails=[];
  for(var i=0;i<ids.length;i++){
    if(stop){ set('정지됨 ('+i+'/'+ids.length+') 변경 '+ok+' · 건너뜀 '+skip+' · 실패 '+fail); setBtn(false); return; }
    set('진행 '+(i+1)+'/'+ids.length+' (필터#'+ids[i]+') → '+target+'개 | 변경 '+ok+' · 건너뜀 '+skip+' · 실패 '+fail);
    try{
      var r=await updateOne(ids[i], target);
      if(r==='ok') ok++; else skip++;
    }catch(e){ fail++; fails.push(ids[i]+':'+e.message); }
    await sleep(120);
  }
  set('완료 — 총 '+ids.length+' | 변경 '+ok+' · 건너뜀(이미 '+target+') '+skip+' · 실패 '+fail+(fails.length?(' | 실패ID: '+fails.slice(0,10).join(', ')):''));
  setBtn(false);
}

// ---------- UI ----------
function set(m){ var s=q('#tmgStat2'); if(s) s.textContent=m; }
function setBtn(running){ var b=q('#tmgGo'); if(b){ b.disabled=running; b.textContent=running?'실행중...':'시작'; } var st=q('#tmgStop2'); if(st) st.style.display=running?'':'none'; }
function ui(){
  if(q('#tmgPanel2')) return;
  var p=document.createElement('div'); p.id='tmgPanel2';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #337ab7;border-radius:8px;padding:10px 12px;width:270px;font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold;margin-bottom:6px">저장상품수 일괄변경</div>'
   +'<div style="margin-bottom:4px">저장상품수: <input id="tmgTarget" type="number" value="100" min="1" style="width:70px"> 개</div>'
   +'<div style="margin-bottom:4px">대상: <select id="tmgSite"><option value="">전체</option><option value="a_rt">ABCmart</option><option value="zara_de">Zara.com/de</option></select></div>'
   +'<button id="tmgGo">시작</button> <button id="tmgStop2" style="display:none;color:#d9534f">정지</button>'
   +'<div id="tmgStat2" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">※ 필터 설정은 유지되고 저장상품수만 변경됩니다.</div>';
  document.body.appendChild(p);
  q('#tmgGo').onclick=run;
  q('#tmgStop2').onclick=function(){ stop=true; };
}
if(document.readyState==='complete') ui(); else window.addEventListener('load', ui);
})();
