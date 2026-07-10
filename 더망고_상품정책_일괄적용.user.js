// ==UserScript==
// @name         더망고 상품정책 일괄 관리(적용/변경/해제)
// @namespace    solddeul.tmg
// @version      2.0
// @description  admin_group.php의 모든 페이지/모든 검색필터에 대해 상품정책을 일괄 적용/변경/해제. select[id^=select_] 기준으로 필터를 열거하므로 이미 적용된 필터의 현재 정책도 읽어, "현재 정책 조건 + 필터이름 포함"으로 대상을 골라 처리할 수 있음(예: 이름이 ABC마트인데 독일자라 정책이 들어간 필터만 변경/해제). 적용/변경=admin_category_ok.php amode=group_config_mapping, 해제=amode=group_config_mapping_remove 를 fetch-POST(사이트의 config_mapping_save/remove와 동일). 페이지 이동/드롭다운 조작 없이 처리. 테스트/N개만/정지 지원.
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_group.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
'use strict';

// ---- 상수 ----
var LIST_FILE = 'admin_group.php';
var SAVE_FILE = 'admin_category_ok.php';
var AMODE_APPLY  = 'group_config_mapping';         // 적용/변경(select 값 저장)
var AMODE_REMOVE = 'group_config_mapping_remove';  // 해제
var MSG_APPLY  = '적용되었습니다';                   // 성공 응답 문구
var MSG_REMOVE = '해제되었습니다';
var PAGE_SIZE = 100;
var POST_DELAY_MS = 150;
var DIR = location.pathname.replace(/[^/]+$/,'');   // /mall/admin/

var stopFlag = false;
var running  = false;

function q(s){ return document.querySelector(s); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function norm(s){ return (s||'').replace(/\s/g,'').toLowerCase(); }

// =========================================================================
// 상품정책 옵션: 페이지의 임의 select_{id}에서 동적으로 읽음(하드코딩 없음)
//   옵션 예: 1=기본설정, 2=솔데글KR-abc마트, 3=솔데글GL-독일자라 (계정마다 다를 수 있음)
// =========================================================================
function readPolicyOptions(){
  var sel = document.querySelector('select[id^="select_"]');
  if(!sel) return [];
  return Array.prototype.slice.call(sel.options)
    .map(function(o){ return { value:(o.value||'').trim(), label:(o.text||'').trim() }; })
    .filter(function(o){ return o.value !== ''; });   // "- 설정 선택 -" 제외
}
function labelOf(value){
  var f = readPolicyOptions().filter(function(o){ return o.value===String(value); })[0];
  return f ? f.label : value;
}

// =========================================================================
// 전 페이지 필터 열거(fetch, 읽기 전용).
//   select[id^=select_] 기준 → uid(=id에서 select_ 제거), name(행의 text input), cur(현재 적용 정책값, '' = 미적용)
//   ★ 이미 적용된 필터는 config_mapping 앵커가 없으므로 select 기준으로 열거해야 전체가 잡힘.
// =========================================================================
function pageUrl(pg){
  var p = new URLSearchParams();
  p.set('ps_duse','1'); p.set('ft_group','all'); p.set('sch_field','title');
  p.set('ft_sort','modify_des'); p.set('ft_num', String(PAGE_SIZE)); p.set('pg', String(pg));
  return DIR + LIST_FILE + '?' + p.toString();
}
function extractRows(doc){
  var sels = Array.prototype.slice.call(doc.querySelectorAll('select[id^="select_"]'));
  return sels.map(function(s){
    var uid = s.id.replace('select_','');
    var tr = s.closest('tr');
    var ni = tr ? tr.querySelector('input[type=text]') : null;
    return { uid:uid, name: ni ? (ni.value||'').trim() : '', cur:(s.value||'') };
  });
}
async function buildAllRows(){
  // 페이지당 행 수가 균일하지 않을 수 있어(예: 1페이지 99~100), 신규 uid가 0일 때에만 종료.
  var all = [], seen = {};
  for(var pg=1; pg<300; pg++){
    var html = await fetch(pageUrl(pg), {credentials:'same-origin'}).then(function(r){ return r.text(); });
    var doc  = new DOMParser().parseFromString(html, 'text/html');
    var rows = extractRows(doc);
    if(!rows.length) break;
    var added = 0;
    rows.forEach(function(r){ if(!seen[r.uid]){ seen[r.uid]=1; all.push(r); added++; } });
    if(added === 0) break;
  }
  return all;
}

// =========================================================================
// 저장/해제: 사이트의 config_mapping_save / config_mapping_remove와 동일 요청을 fetch-POST로 재현
// =========================================================================
async function postPolicy(params){
  var body = new URLSearchParams(params);
  var resp = await fetch(DIR + SAVE_FILE, {
    method:'POST', credentials:'same-origin',
    headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
    body: body.toString()
  });
  var text=''; try{ text = await resp.text(); }catch(e){}
  return { status:resp.status, text:text };
}
async function applyPolicy(uid, configUid){
  return postPolicy({ amode:AMODE_APPLY, uid:String(uid), config_uid:String(configUid) });
}
async function removePolicy(uid){
  return postPolicy({ amode:AMODE_REMOVE, uid:String(uid) });
}

// =========================================================================
// 실행
// =========================================================================
async function run(){
  if(running) return;
  var opts = readPolicyOptions();
  if(!opts.length){ setStat('상품정책 옵션을 읽지 못했습니다. 목록에 필터가 있는지 확인하세요.'); return; }

  var op = (q('#tmgPolOp')||{}).value || 'apply';          // apply | remove
  var curCond = (q('#tmgPolCur')||{}).value;               // '' = 전체, '__none__' = 미적용, 그 외 정책값
  var nameSub = norm((q('#tmgPolName')||{}).value || '');
  var targetEl = q('#tmgPolTarget');
  var target = targetEl ? targetEl.value : '';
  var targetLabel = targetEl ? (targetEl.options[targetEl.selectedIndex]||{}).text : '';
  var dry  = q('#tmgPolDry') && q('#tmgPolDry').checked;
  var maxv = parseInt((q('#tmgPolMax') && q('#tmgPolMax').value) || '0', 10) || 0;

  if(op==='apply' && !target){ setStat('변경할(적용할) 상품정책을 먼저 선택하세요.'); return; }

  running = true; stopFlag = false; setBtns(true);
  setStat('대상 필터 열거 중...');
  var rows;
  try{ rows = await buildAllRows(); }
  catch(e){ setStat('필터 열거 실패: ' + e.message); running=false; setBtns(false); return; }
  if(!rows.length){ setStat('필터가 없습니다.'); running=false; setBtns(false); return; }

  // 대상 필터링: 현재 정책 조건 + 이름 포함
  var picked = rows.filter(function(r){
    if(curCond==='__none__'){ if(r.cur!=='') return false; }
    else if(curCond!==''){ if(r.cur!==curCond) return false; }
    if(nameSub && norm(r.name).indexOf(nameSub)<0) return false;
    return true;
  });
  // 적용/변경: 이미 목표 정책인 필터는 무의미하므로 건너뜀
  var skipSame = 0;
  if(op==='apply'){
    picked = picked.filter(function(r){ if(r.cur===target){ skipSame++; return false; } return true; });
  }

  if(!picked.length){
    setStat('조건에 맞는 대상이 없습니다.' + (skipSame?(' (이미 해당 정책 '+skipSame+'개 제외)'):''));
    running=false; setBtns(false); return;
  }

  var total = maxv > 0 ? Math.min(maxv, picked.length) : picked.length;
  var condTxt = (curCond==='' ? '전체' : (curCond==='__none__' ? '미적용' : ('현재='+labelOf(curCond))))
              + (nameSub ? (' · 이름포함="'+((q('#tmgPolName')||{}).value||'').trim()+'"') : '');
  var actTxt = (op==='apply') ? ('정책 "'+targetLabel+'"(으)로 적용/변경') : '정책 해제';
  if(!confirm('대상 조건: ' + condTxt + '\n작업: ' + actTxt
      + '\n대상 ' + picked.length + '개 중 ' + total + '개를 '
      + (dry?'[테스트: 저장 안 함]':'[실제 실행]') + ' 합니다.'
      + (skipSame?('\n(이미 해당 정책이라 제외된 '+skipSame+'개는 미포함)'):'')
      + '\n진행할까요?')){
    setStat('취소됨'); running=false; setBtns(false); return;
  }

  var ok=0, fail=0, log=[];
  for(var i=0; i<total; i++){
    if(stopFlag){ setStat('정지됨 — ' + i + '/' + total + ' 처리(성공 ' + ok + ' / 실패 ' + fail + ')'); break; }
    var it = picked[i];
    setStat('[' + (i+1) + '/' + total + '] ' + (it.name || ('uid '+it.uid)) + ' ' + (op==='apply'?'적용/변경':'해제') + ' 중... (성공 ' + ok + ' / 실패 ' + fail + ')');
    if(dry){ log.push({uid:it.uid, name:it.name, from:it.cur, op:op, to:(op==='apply'?target:''), done:false, dry:true}); ok++; await sleep(10); continue; }
    try{
      var res = (op==='apply') ? await applyPolicy(it.uid, target) : await removePolicy(it.uid);
      var want = (op==='apply') ? MSG_APPLY : MSG_REMOVE;
      var good = res.status===200 && res.text.indexOf(want)>=0;
      if(good){ ok++; log.push({uid:it.uid, name:it.name, from:it.cur, op:op, to:(op==='apply'?target:''), done:true}); }
      else { fail++; log.push({uid:it.uid, name:it.name, from:it.cur, op:op, done:false, err:'HTTP '+res.status+' '+res.text.slice(0,40)}); }
    }catch(e){ fail++; log.push({uid:it.uid, name:it.name, op:op, done:false, err:String(e)}); }
    await sleep(POST_DELAY_MS);
  }

  var doneMsg = (stopFlag ? '정지' : '완료') + ' — 대상 ' + total + ' | 성공 ' + ok + ' / 실패 ' + fail
    + (dry ? ' (테스트: 저장 안 함)' : '')
    + (op==='apply' ? (' · 정책 "'+targetLabel+'"') : ' · 해제')
    + (skipSame ? (' · 동일정책 제외 '+skipSame) : '');
  setStat(doneMsg + ' — 변경 반영 확인은 페이지 새로고침');
  try{ console.log('[TMG 상품정책 관리] 결과:', JSON.stringify(log, null, 1)); }catch(e){}
  running=false; setBtns(false);
}

function stop(){ stopFlag = true; setStat('정지 요청됨 — 현재 항목 후 멈춥니다.'); }

// =========================================================================
// UI
// =========================================================================
function setStat(m){ var el=q('#tmgPolStat'); if(el) el.textContent=m; }
function setBtns(isRun){
  var go=q('#tmgPolGo'), sb=q('#tmgPolStop');
  if(go){ go.disabled=isRun; go.textContent=isRun?'진행중...':'시작'; }
  if(sb) sb.style.display=isRun?'':'none';
}
function policyOptionHtml(){
  return readPolicyOptions().map(function(o){ return '<option value="'+o.value+'">'+o.label+'</option>'; }).join('');
}
function fillSelects(){
  var t=q('#tmgPolTarget'); if(t){ t.innerHTML='<option value="">- 적용할 정책 선택 -</option>'+policyOptionHtml(); }
  var c=q('#tmgPolCur'); if(c){ c.innerHTML='<option value="">전체</option><option value="__none__">미적용</option>'+policyOptionHtml(); }
}
function syncOpUI(){
  var op=(q('#tmgPolOp')||{}).value;
  var box=q('#tmgPolTargetBox');
  if(box) box.style.display = (op==='apply') ? '' : 'none';
}
function ui(){
  if(q('#tmgPolPanel')) return;
  var p=document.createElement('div'); p.id='tmgPolPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #f0932b;border-radius:8px;padding:10px 12px;width:300px;font:12px/1.6 "malgun gothic",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML=''
   +'<div style="font-weight:bold;margin-bottom:6px">상품정책 일괄 관리</div>'
   +'<div style="margin-bottom:4px">작업: <select id="tmgPolOp"><option value="apply">적용/변경</option><option value="remove">해제(삭제)</option></select></div>'
   +'<div style="border-top:1px dashed #ddd;margin:6px 0 4px;padding-top:4px;color:#555">대상 조건</div>'
   +'<div style="margin-bottom:4px">현재 정책: <select id="tmgPolCur"></select></div>'
   +'<div style="margin-bottom:4px">이름 포함: <input id="tmgPolName" type="text" placeholder="예: ABC마트" style="width:150px"></div>'
   +'<div id="tmgPolTargetBox" style="margin:6px 0 4px;border-top:1px dashed #ddd;padding-top:6px">변경할 정책: <select id="tmgPolTarget"></select></div>'
   +'<div style="margin-bottom:4px"><label><input type="checkbox" id="tmgPolDry"> 테스트(저장 안 함)</label></div>'
   +'<div style="margin-bottom:4px">앞에서 <input id="tmgPolMax" type="number" value="0" min="0" style="width:55px"> 개만 (0=전체)</div>'
   +'<button id="tmgPolGo">시작</button> <button id="tmgPolStop" style="display:none;color:#d9534f">정지</button>'
   +'<div id="tmgPolStat" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">조건에 맞는 모든 페이지의 필터에 일괄 처리됩니다. 결과 상세는 콘솔(F12). 처리 후 새로고침해야 화면에 반영됩니다.</div>';
  document.body.appendChild(p);
  fillSelects();
  syncOpUI();
  q('#tmgPolOp').onchange=syncOpUI;
  q('#tmgPolGo').onclick=run;
  q('#tmgPolStop').onclick=stop;
}

function init(){ ui(); }
if(document.readyState==='complete') init(); else window.addEventListener('load', init);
})();
