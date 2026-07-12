// ==UserScript==
// @name         더망고 카테고리매핑 수집·추출(+이상 케이스 리포트)
// @namespace    solddeul.tmg
// @version      1.0
// @description  검색필터별로 저장된 (오픈)마켓 카테고리 매핑을 fetch로 수집해 CSV로 추출하고, 규칙 기반으로 이상 케이스 리포트(txt)를 함께 내려받는다. 페이지 이동·저장 없이 읽기 전용. 대상은 필터이름 키워드로 지정(기본 '독일자라').
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_group.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
'use strict';

var MARKETS=['AUC20','GMK20','11ST','SMART','COUP','LTON','LFMALL','MUSTIT','SHOPEE','QOO10JP','PLAYAUTO'];
var MLABEL={AUC20:'옥션',GMK20:'G마켓','11ST':'11번가',SMART:'스마트스토어',COUP:'쿠팡',LTON:'롯데ON',LFMALL:'LF몰',MUSTIT:'머스트잇',SHOPEE:'쇼피',QOO10JP:'큐텐JP',PLAYAUTO:'플레이오토'};

function DIR(){ return location.pathname.replace(/[^/]+$/,''); }
function q(s){ return document.querySelector(s); }
function setStat(m){ var s=q('#tmgExStat'); if(s) s.textContent=m; }

// ============ 상품유형/성별 분류 (본 매핑 매크로와 동일 규칙) ============
function classify(name){
  var g=name.indexOf('여성')>=0?'W':(name.indexOf('남성')>=0?'M':'U'); var n=name, base;
  if(/가방/.test(n)) base='가방';
  else if(/애슬레틱/.test(n)){ base=/신발/.test(n)?'스니커즈':(/트레이닝/.test(n)?'트레이닝':(/양말|타이츠/.test(n)?'양말':'트레이닝')); }
  else if(/신발|스니커즈/.test(n)) base='스니커즈';
  else if(/수영복|비치웨어/.test(n)){ base=/가방/.test(n)?'가방':'수영복'; }
  else if(/청바지|데님/.test(n)) base='청바지';
  else if(/반바지|버뮤다|스코츠/.test(n)) base='반바지';
  else if(/스커트/.test(n)) base='스커트';
  else if(/원피스/.test(n)) base='원피스';
  else if(/점프수트/.test(n)) base='점프수트';
  else if(/보디수트/.test(n)) base='보디수트';
  else if(/코디세트/.test(n)) base='세트';
  else if(/블레이저|자켓|재킷/.test(n)) base='자켓';
  else if(/코트아우터|코트/.test(n)) base='코트';
  else if(/니트/.test(n)) base='니트';
  else if(/스웨트셔츠|맨투맨/.test(n)) base='맨투맨';
  else if(/폴로/.test(n)) base='카라티셔츠';
  else if(/티셔츠/.test(n)) base='티셔츠';
  else if(/탑/.test(n)) base=g==='W'?'블라우스':'티셔츠';
  else if(/오버셔츠/.test(n)) base='셔츠';
  else if(/수트/.test(n)){ base=/액세서리/.test(n)?'넥타이':'셔츠'; }
  else if(/셔츠/.test(n)) base='셔츠';
  else if(/액세서리/.test(n)){ base=/모자/.test(n)?'모자':/벨트/.test(n)?'벨트':/양말/.test(n)?'양말':/선글라스/.test(n)?'선글라스':/넥타이/.test(n)?'넥타이':/반다나|스카프/.test(n)?'스카프':/주얼리/.test(n)?'주얼리':'패션소품'; }
  else if(/바지|린넨|슬랙스|조거|치노|팬츠/.test(n)) base='슬랙스';
  else base='의류';
  return { gender:g, base:base };
}

// ============ 이상 케이스 규칙 ============
var COMMON_FORBIDDEN=/(어린이|유아|도서|e쿠폰|모바일|렌탈|배달음식|출산|육아|임산부|위생용품|의료기기|의약품)/;
var ELEVEN_FORBIDDEN=/(디자이너|biz)/i;   // 11번가
var BRAND_FORBIDDEN=/브랜드/;             // 옥션/지마켓
var INVALID_MARK=/카테고리를\s*변경|변경해주세요/;  // 사이트가 무효로 표시
var PET=/반려|애완|강아지|고양이|반려동물/;
var FAM={
  TOP:/티셔츠|셔츠|블라우스|니트|맨투맨|스웨트|후드|폴로|나시|카디건|상의|탑/,
  OUTER:/코트|자켓|재킷|점퍼|패딩|블레이저|아우터|야상|바람막이/,
  BOTTOM:/바지|팬츠|반바지|청바지|슬랙스|데님|레깅스|조거|치노|숏팬츠|핫팬츠|하의/,
  SKIRT:/스커트|치마/,
  DRESS:/원피스|드레스|점프수트|보디수트|jumpsuit|dress/i,
  SHOES:/신발|스니커즈|운동화|구두|부츠|샌들|슬리퍼|로퍼|힐|shoes|boots|sneaker/i,
  BAG:/가방|백팩|클러치|토트|숄더|크로스백|핸드백|bag/i,
  ACC:/모자|캡|비니|벨트|양말|선글라스|아이웨어|넥타이|스카프|머플러|목도리|장갑|주얼리|액세서리|악세|패션소품|잡화|acc/i,
  SWIM:/수영|비치|스윔|비키니|래시가드|swim/i
};
var baseFam={'가방':'BAG','스니커즈':'SHOES','양말':'ACC','수영복':'SWIM','청바지':'BOTTOM','반바지':'BOTTOM','스커트':'SKIRT','원피스':'DRESS','점프수트':'DRESS','보디수트':'DRESS','자켓':'OUTER','코트':'OUTER','니트':'TOP','맨투맨':'TOP','카라티셔츠':'TOP','티셔츠':'TOP','블라우스':'TOP','셔츠':'TOP','넥타이':'ACC','슬랙스':'BOTTOM','모자':'ACC','벨트':'ACC','선글라스':'ACC','스카프':'ACC','주얼리':'ACC','패션소품':'ACC'};
function famsOf(t){ var r=[]; for(var k in FAM){ if(FAM[k].test(t)) r.push(k); } return r; }

function analyze(rows){
  var flags=[];
  rows.forEach(function(f){
    var c=classify(f.name);
    MARKETS.forEach(function(m){
      var cat=(f.markets[m]&&f.markets[m].text)||'';
      if(!cat){ flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:'(비어있음)',type:'미매핑',detail:''}); return; }
      if(INVALID_MARK.test(cat)) flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat,type:'사이트무효표시',detail:'카테고리 변경 요구'});
      if(PET.test(cat)) flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat,type:'규칙위반-반려동물',detail:cat.match(PET)[0]});
      if(COMMON_FORBIDDEN.test(cat)) flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat,type:'규칙위반-금지어',detail:cat.match(COMMON_FORBIDDEN)[0]});
      if(m==='11ST'&&ELEVEN_FORBIDDEN.test(cat)) flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat,type:'규칙위반-11번가디자이너/biz',detail:cat.match(ELEVEN_FORBIDDEN)[0]});
      if((m==='AUC20'||m==='GMK20')&&BRAND_FORBIDDEN.test(cat)) flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat,type:'규칙위반-브랜드',detail:'브랜드 포함'});
      var hasW=/여성|여자|women|woman|레이디|ladies/i.test(cat), hasM=/남성|남자|\bmen\b|\bman\b/i.test(cat);
      if(c.gender==='W'&&hasM&&!hasW) flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat,type:'성별불일치',detail:'여성필터→남성카테고리'});
      if(c.gender==='M'&&hasW&&!hasM) flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat,type:'성별불일치',detail:'남성필터→여성카테고리'});
      var bf=baseFam[c.base];
      if(bf){ var fams=famsOf(cat); if(fams.length&&fams.indexOf(bf)<0) flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat,type:'유형검토(추정)',detail:c.base+'('+bf+')→'+fams.join(',')}); }
    });
  });
  return flags;
}

// ============ 수집 ============
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
async function getPage(pg){
  var p=new URLSearchParams();
  p.set('ps_duse','1'); p.set('ft_group','all'); p.set('sch_field','title');
  p.set('ft_sort','modify_des'); p.set('ft_num','100'); p.set('pg',String(pg));
  var h=await fetch(DIR()+'admin_group.php?'+p.toString(),{credentials:'same-origin'}).then(function(r){return r.text();});
  var doc=new DOMParser().parseFromString(h,'text/html');
  var rows=[];
  Array.prototype.slice.call(doc.querySelectorAll('a,button')).forEach(function(b){
    var oc=(b.getAttribute&&b.getAttribute('onclick'))||'';
    var mm=oc.match(/market_mapping_new\((['"])(\d+)\1\)/);
    if(!mm) return;
    var tr=b.closest('tr'); var ni=tr?tr.querySelector('input[type=text]'):null;
    rows.push({id:mm[2], name:ni?ni.value.trim():'', status:(b.textContent||'').trim()});
  });
  return rows;
}
async function collectIds(keyword){
  var all=[], seen={};
  for(var pg=1; pg<=12; pg++){
    var r=await getPage(pg); if(!r.length) break;
    r.forEach(function(x){ if(!seen[x.id]){ seen[x.id]=1; all.push(x); } });
    if(r.length<100) break;
  }
  return all.filter(function(x){ return !keyword || x.name.indexOf(keyword)>=0; })
            .map(function(x){ return {id:x.id, name:x.name, status:x.status}; });
}
async function harvestOne(item){
  var h=await fetch(DIR()+'admin_category_set.php?tm=F&ps_ftid='+item.id,{credentials:'same-origin'}).then(function(r){return r.text();});
  var doc=new DOMParser().parseFromString(h,'text/html');
  var markets={};
  MARKETS.forEach(function(m){
    var sel=doc.getElementById('openmarket_category_search_list_'+m);
    if(sel && sel.options.length){ var o=sel.options[sel.selectedIndex]||sel.options[0]; markets[m]={text:(o.text||'').trim(), val:o.value}; }
    else markets[m]={text:'', val:''};
  });
  return {id:item.id, name:item.name, status:item.status, markets:markets};
}

// ============ 파일 생성/다운로드 ============
function csvq(s){ s=(s==null?'':String(s)); return '"'+s.replace(/"/g,'""')+'"'; }
function buildCSV(rows){
  var cols=['id','필터명','상태','성별','유형(base)'].concat(MARKETS.map(function(m){return MLABEL[m];}));
  var csv=cols.map(csvq).join(',')+'\n';
  rows.forEach(function(f){
    var c=classify(f.name);
    var row=[f.id,f.name,f.status||'',({W:'여성',M:'남성',U:'공용'})[c.gender],c.base]
      .concat(MARKETS.map(function(m){ return (f.markets[m]&&f.markets[m].text)||''; }));
    csv+=row.map(csvq).join(',')+'\n';
  });
  return '﻿'+csv; // Excel 한글 대응 BOM
}
function buildReport(rows, flags, keyword){
  var now=new Date().toISOString().slice(0,16).replace('T',' ');
  var byType={}; flags.forEach(function(x){ byType[x.type]=(byType[x.type]||0)+1; });
  var R='';
  R+='========================================================\n';
  R+=' 더망고 카테고리매핑 이상 케이스 리포트\n';
  R+=' 대상 키워드: '+(keyword||'(전체)')+'  |  필터 '+rows.length+'개  |  생성 '+now+'\n';
  R+='========================================================\n\n[요약]\n';
  Object.keys(byType).sort(function(a,b){return byType[b]-byType[a];}).forEach(function(k){ R+='  '+k+': '+byType[k]+'건\n'; });
  R+='\n확정 위반(규칙/사이트표시)은 즉시 수정 대상, 유형검토(추정)는 사람이 확인 후 판단.\n';
  function sect(title, type){
    R+='\n─────────────────────────────────────\n'+title+'\n─────────────────────────────────────\n';
    var arr=flags.filter(function(f){return f.type===type;});
    if(!arr.length){ R+='  (없음)\n'; return; }
    arr.forEach(function(f){ R+='  - ['+f.id+'] '+f.name+'\n      '+f.market+': '+f.cat+'\n'; });
  }
  sect('[A] 사이트 무효 표시 (카테고리를 변경해주세요)','사이트무효표시');
  sect('[B] 규칙위반 · 반려동물 카테고리','규칙위반-반려동물');
  sect('[C] 규칙위반 · 옥션/지마켓 브랜드 포함','규칙위반-브랜드');
  sect('[D] 규칙위반 · 11번가 디자이너/biz','규칙위반-11번가디자이너/biz');
  sect('[E] 규칙위반 · 공통 금지어','규칙위반-금지어');
  sect('[F] 성별 불일치','성별불일치');
  sect('[G] 미매핑(빈 카테고리)','미매핑');
  // [H] 유형검토 — 패턴별 그룹
  R+='\n─────────────────────────────────────\n[H] 유형 불일치 (추정 — 검토 필요)\n─────────────────────────────────────\n';
  var soft=flags.filter(function(f){return f.type==='유형검토(추정)';});
  var pat={}; soft.forEach(function(f){ (pat[f.detail]=pat[f.detail]||[]).push(f); });
  Object.keys(pat).sort(function(a,b){return pat[b].length-pat[a].length;}).forEach(function(k){
    R+='\n▶ '+k+' ('+pat[k].length+'건)\n';
    pat[k].forEach(function(f){ R+='  - ['+f.id+'] '+f.name+'\n      '+f.market+': '+f.cat+'\n'; });
  });
  return R;
}
function download(name, text){
  var blob=new Blob([text],{type:'text/plain;charset=utf-8'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a'); a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}

// ============ 실행 ============
async function run(){
  var keyword=(q('#tmgExKw')&&q('#tmgExKw').value.trim());
  if(keyword==null) keyword='독일자라';
  try{
    setStat('필터 목록 수집 중...');
    var ids=await collectIds(keyword);
    if(!ids.length){ setStat('대상 필터 없음 (키워드: '+keyword+')'); return; }
    var rows=[];
    for(var i=0;i<ids.length;i++){
      setStat('매핑 수집 '+(i+1)+'/'+ids.length+' — '+ids[i].name);
      rows.push(await harvestOne(ids[i]));
      if(i%10===9) await sleep(120); // 서버 배려
    }
    setStat('이상 케이스 분석 중...');
    var flags=analyze(rows);
    var stamp=new Date().toISOString().slice(0,10);
    download('카테고리매핑_'+ (keyword||'전체') +'_'+stamp+'.csv', buildCSV(rows));
    download('이상케이스리포트_'+ (keyword||'전체') +'_'+stamp+'.txt', buildReport(rows, flags, keyword));
    var hard=flags.filter(function(f){return f.type!=='유형검토(추정)'&&f.type!=='미매핑';}).length;
    var soft=flags.filter(function(f){return f.type==='유형검토(추정)';}).length;
    setStat('완료 — 필터 '+rows.length+' · 확정위반 '+hard+' · 유형검토 '+soft+' (파일 2개 다운로드됨)');
  }catch(e){ setStat('오류: '+(e&&e.message||e)); }
}

// ============ UI ============
function panel(){
  if(q('#tmgExPanel')) return;
  var p=document.createElement('div'); p.id='tmgExPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #2e86de;border-radius:8px;padding:10px 12px;width:310px;font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold;margin-bottom:6px">카테고리매핑 수집·추출</div>'
   +'<div style="margin-bottom:4px">대상 필터이름 키워드: <input id="tmgExKw" type="text" value="독일자라" style="width:120px"> <span style="color:#888">(비우면 전체)</span></div>'
   +'<button id="tmgExGo">매핑 수집 &amp; 파일 추출</button>'
   +'<div id="tmgExStat" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">※ 저장·페이지이동 없이 읽기만 합니다. CSV(전체 매핑) + 이상케이스 리포트(txt) 2개 파일이 다운로드됩니다.</div>';
  document.body.appendChild(p);
  q('#tmgExGo').onclick=run;
}
panel();
})();
