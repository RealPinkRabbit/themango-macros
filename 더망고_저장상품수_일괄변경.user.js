// ==UserScript==
// @name         더망고 신규상품수집 - 저장상품수 일괄변경
// @namespace    solddeul.tmg
// @version      1.3
// @description  신규상품수집 목록의 "저장상품수(limit_count)"를 지정값(기본 100)으로 일괄 변경. 팝업/새로고침 없이 fetch로 수정폼을 읽어 limit_count만 바꿔 저장(다른 설정 보존). v1.3부터 대상은 이 화면의 검색조건(날짜검색·수집사이트·매출발생여부·필터명 키워드 등)을 그대로 따르고, 시작 전에 대상 건수와 조건을 확인한다.
// @match        https://tmg4682.mycafe24.com/mall/admin/shop/getGoodsCategory.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
'use strict';

var DIR = location.pathname.replace(/[^/]+$/,'');            // /mall/admin/shop/
var LIST_URL = DIR + 'getGoodsCategory.php';
var stop=false;

// 조회조건에서 빼는 파라미터.
//  - pg/ft_num : 열거하면서 매크로가 직접 정한다.
//  - pmode/uids/chk_value/all_chk : 목록 선택·삭제용 필드다. 페이지의 검색 버튼(search_filter)이
//    폼을 통째로 GET 제출하는데 pmode를 비우지 않아 URL에 pmode=filter_delete가 섞여 들어온다.
//    조회에는 영향이 없지만 삭제용 값을 그대로 실어 보낼 이유가 없으므로 잘라낸다.
var DROP = ['pg','ft_num','pmode','uids','chk_value','all_chk'];
var DATE_KEYS = ['date_type','start_yy','start_mm','start_dd','end_yy','end_mm','end_dd'];

function q(s){ return document.querySelector(s); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }

// 현재 화면의 조회조건 = 지금 URL에 실려 있는 검색 파라미터.
// 검색폼이 GET이라 URL이 곧 화면 상태다 → "화면에 보이는 목록 = 바꿀 대상"이 항상 성립한다.
// 아는 항목만 골라 담지 않고 그대로 넘기므로, 더망고가 검색항목을 추가해도 코드 수정 없이 따라간다.
function searchParams(){
  var p=new URLSearchParams(location.search);
  DROP.forEach(function(k){ p.delete(k); });
  return p;
}

function siteText(v){
  var src=document.querySelector('form[name=fm_search] select[name=site_id]') || document.querySelector('select[name=site_id]');
  if(src) for(var i=0;i<src.options.length;i++) if(src.options[i].value===v) return src.options[i].text.trim();
  return v;
}
function ymd(p,pre){
  var y=p.get(pre+'_yy'), m=p.get(pre+'_mm'), d=p.get(pre+'_dd');
  return (y&&m&&d) ? y+'-'+('0'+m).slice(-2)+'-'+('0'+d).slice(-2) : '?';
}

// 조건 요약. 아는 항목은 한글로 풀고, 모르는 항목은 원문 그대로 남긴다
// — 화면에 안 보이는 조건이 조용히 적용되는 일이 없게.
function describe(p){
  var out=[], seen={};
  function mark(){ Array.prototype.slice.call(arguments).forEach(function(k){ seen[k]=1; }); }

  // ★ ps_duse=1이 없으면 서버가 날짜를 통째로 무시한다(실측: 날짜만 넣으면 전체 결과와 동일).
  //    셀렉트에 날짜가 남아 있어도 '미사용'이므로 요약에도 쓰지 않는다.
  mark.apply(null, ['ps_duse'].concat(DATE_KEYS));
  if(p.get('ps_duse')==='1')
    out.push((p.get('date_type')==='modify' ? '최근수집일' : '필터생성일')+' '+ymd(p,'start')+' ~ '+ymd(p,'end'));

  mark('site_id');     if(p.get('site_id'))     out.push('수집사이트 '+siteText(p.get('site_id')));
  mark('sales_yn');    if(p.get('sales_yn'))    out.push('매출 '+(p.get('sales_yn')==='Y'?'있음':'없음'));
  mark('sch_keyword'); if(p.get('sch_keyword')) out.push('필터명 "'+p.get('sch_keyword')+'"');

  mark('ft_show');
  var fs=p.get('ft_show');
  if(fs==='saved')      out.push('상품이 저장된 필터만');
  else if(fs==='sales') out.push('매출이 발생한 필터만');

  mark('ft_sort');     // 정렬은 대상 집합을 바꾸지 않는다

  p.forEach(function(v,k){ if(!seen[k] && v!=='') out.push(k+'='+v); });
  return out;
}
function condLine(cond){ return cond.length ? cond.join(' · ') : '없음 — 전체 필터'; }

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

async function enumerateIds(){
  var base=searchParams(), ids=[];
  for(var pg=1; pg<200; pg++){
    if(stop) break;
    var p=new URLSearchParams(base);
    p.set('ft_num','100'); p.set('pg',String(pg));
    var html=await fetch(LIST_URL+'?'+p.toString(),{credentials:'same-origin'}).then(function(r){return r.text();});
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

// 변경 없이 대상 건수만 확인
async function preview(){
  stop=false; setBtn(true,'조회중...');
  set('대상 조회 중...');
  try{
    var ids=await enumerateIds();
    set(stop ? '조회 정지됨 — 아무것도 변경하지 않았습니다.'
             : '대상 '+ids.length+'개\n조건: '+condLine(describe(searchParams())));
  }catch(e){ set('조회 실패: '+e.message); }
  setBtn(false);
}

async function run(){
  var target=parseInt((q('#tmgTarget')&&q('#tmgTarget').value)||'100',10);
  if(!(target>0)){ alert('저장상품수를 올바르게 입력하세요.'); return; }

  stop=false; setBtn(true,'조회중...');
  set('대상 조회 중...');
  var ids;
  try{ ids=await enumerateIds(); }catch(e){ set('목록 조회 실패: '+e.message); setBtn(false); return; }
  if(stop){ set('조회 정지됨 — 아무것도 변경하지 않았습니다.'); setBtn(false); return; }

  var cond=describe(searchParams());
  if(!ids.length){ set('대상 필터가 없습니다.\n조건: '+condLine(cond)); setBtn(false); return; }

  var msg='저장상품수를 '+target+'개로 일괄 변경합니다.\n\n'
        + '대상: '+ids.length+'개 필터\n'
        + '조건: '+(cond.length ? '\n · '+cond.join('\n · ') : '없음\n\n⚠ 검색조건이 없어 전체 필터가 대상입니다.')
        + '\n\n진행할까요?';
  if(!confirm(msg)){ set('취소됨 — 아무것도 변경하지 않았습니다.'); setBtn(false); return; }

  setBtn(true);
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
  set('완료 — 총 '+ids.length+' | 변경 '+ok+' · 건너뜀(이미 '+target+') '+skip+' · 실패 '+fail
      +(fails.length?(' | 실패ID: '+fails.slice(0,10).join(', ')):'')
      +'\n조건: '+condLine(cond));
  setBtn(false);
}

// ---------- UI ----------
function set(m){ var s=q('#tmgStat2'); if(s) s.textContent=m; }
function setBtn(running, label){
  var b=q('#tmgGo');    if(b){ b.disabled=running; b.textContent=running?(label||'실행중...'):'시작'; }
  var pv=q('#tmgPrev'); if(pv) pv.disabled=running;
  var st=q('#tmgStop2');if(st) st.style.display=running?'':'none';
}
// 조건이 하나도 없으면(=전체 필터) 붉게 띄워 알린다. 조용히 전체가 대상이 되는 상황을 만들지 않는다.
function showCond(){
  var c=describe(searchParams()), el=q('#tmgCond'); if(!el) return;
  el.textContent='현재 조회조건\n'+(c.length ? ' · '+c.join('\n · ') : ' 없음 — 전체 필터');
  el.style.color = c.length ? '#333' : '#b94a48';
}
function ui(){
  if(q('#tmgPanel2')) return;
  var p=document.createElement('div'); p.id='tmgPanel2';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #337ab7;border-radius:8px;padding:10px 12px;width:300px;font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold;margin-bottom:6px">저장상품수 일괄변경</div>'
   +'<div style="margin-bottom:6px">저장상품수: <input id="tmgTarget" type="number" value="100" min="1" style="width:70px"> 개</div>'
   +'<div id="tmgCond" style="margin-bottom:6px;padding:6px;background:#f5f8fb;border:1px solid #dbe5ee;border-radius:4px;white-space:pre-wrap"></div>'
   +'<button id="tmgPrev">대상 조회</button> <button id="tmgGo">시작</button> <button id="tmgStop2" style="display:none;color:#d9534f">정지</button>'
   +'<div id="tmgStat2" style="margin-top:8px;color:#333;min-height:32px;white-space:pre-wrap">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">※ 대상은 <b>이 화면의 검색조건</b>을 그대로 따릅니다. 조건을 바꾸려면 위 검색폼에서 조건을 고르고 <b>검색</b>을 누르세요.<br>※ 필터 설정은 유지되고 저장상품수만 변경됩니다.</div>';
  document.body.appendChild(p);
  q('#tmgGo').onclick=run;
  q('#tmgPrev').onclick=preview;
  q('#tmgStop2').onclick=function(){ stop=true; };
  showCond();
}
if(document.readyState==='complete') ui(); else window.addEventListener('load', ui);
})();
