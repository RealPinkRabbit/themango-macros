// ==UserScript==
// @name         더망고 카테고리매핑 단계형 자동(사이트 트리 순차 + 규칙기반 검수)
// @namespace    solddeul.tmg
// @version      1.0
// @description  단계형 카테고리매핑(admin_category_new.php) 자동화. 사이트(기본 ABC마트)의 카테고리 트리를 admin_category_get_load.php로 fetch-DFS해 모든 최소단위(리프) 카테고리를 열거하고, 각 리프의 카테고리설정 팝업(admin_category_set.php?category_id=..)을 순차로 열어 AI자동매핑→11개 마켓 규칙 재선택(11번가=국내)→고시→fetch-POST 저장. 매핑 팝업 로직은 "카테고리매핑(수동/자동)" 매크로와 동일. THE MANGO 사이트는 제외. localStorage로 새로고침을 넘어 진행. 테스트(저장 안 함) 모드 지원.
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_category_new.php*
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_category_set.php*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function(){
'use strict';

// ---- 네이티브 대화상자 무력화(자동매핑/저장검증 alert가 렌더러를 멈추는 것 방지) ----
// ※ 시작 게이트(startRun의 진행 확인)는 아래 _nativeConfirm으로 실제 확인창을 띄운다.
var _alerts=[];
var _nativeConfirm=(window.confirm&&window.confirm.bind(window))||function(){return true;};
try{ window.alert=function(m){ _alerts.push(String(m)); }; }catch(e){}
try{ window.confirm=function(){ return true; }; }catch(e){}

var LS='tmg_catmap_step_v1';      // {running, dry, idx, ok, fail, skip, max, psUid, site, queue:[{id,name}], log:[]}
var _stopStart=false;
var MARKETS=['AUC20','GMK20','11ST','SMART','COUP','LTON','LFMALL','MUSTIT','SHOPEE','QOO10JP','PLAYAUTO'];
var MLABEL={AUC20:'옥션',GMK20:'G마켓','11ST':'11번가',SMART:'스마트스토어',COUP:'쿠팡',LTON:'롯데ON',LFMALL:'LF몰',MUSTIT:'머스트잇',SHOPEE:'쇼피',QOO10JP:'큐텐JP',PLAYAUTO:'플레이오토'};
// 트리 로드 시 서버로 넘기는 use_market(15종). 페이지의 #use_market 값을 우선 사용, 없으면 이 상수.
var USE_MARKET_DEFAULT='["AUC20","GMK20","11ST","SMART","COUP","LTON","LFMALL","MUSTIT","SHOPEE","QOO10JP","SHOPIFY","CAFE24","GODO","IMWEB","PLAYAUTO"]';

var FORBIDDEN=/(어린이|유아|아동|도서|서적|e쿠폰|모바일|렌탈|렌터카|배달음식|출산|육아|임산부|임부|위생용품|의료기기|의약품|Baby|Kids|Toddler|Infant|Children|Maternity)/i;
var PET=/(반려|애완|강아지|고양이|반려동물|\bPets?\b)/i;
var INVALID_MARK=/(카테고리를\s*변경|변경해주세요)/;
var ELEVEN_FORBIDDEN=/(디자이너|biz)/i;

function gs(){ try{ return JSON.parse(localStorage.getItem(LS))||null; }catch(e){ return null; } }
function ss(s){ localStorage.setItem(LS, JSON.stringify(s)); }
function clr(){ localStorage.removeItem(LS); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function q(s){ return document.querySelector(s); }
function DIR(){ return location.pathname.replace(/[^/]+$/,''); }

// =========================================================================
// 분류 & 키워드 (수동/자동 매크로와 동일). 단계형은 성별이 상위노드(MEN/WOMEN)에 있으므로
// 큐 생성 시 전체 경로명을 만들고 MEN→남성/WOMEN→여성으로 정규화해 이 함수가 인식하게 함.
// =========================================================================
function classify(name){
  var g = name.indexOf('여성')>=0 ? 'W' : (name.indexOf('남성')>=0 ? 'M' : 'U');
  var gk = g==='W' ? '여성' : (g==='M' ? '남성' : '');
  var n = name;
  var base;
  if(/가방|백팩|파우치|숄더|토트|클러치|크로스/.test(n)) base='가방';
  else if(/애슬레틱/.test(n)){ base = /신발/.test(n)?'스니커즈' : (/트레이닝/.test(n)?'트레이닝' : (/양말|타이츠/.test(n)?'양말':'트레이닝')); }
  else if(/신발|스니커즈|운동화|구두|부츠|샌들|슬리퍼|로퍼|힐|워킹화|더비|레이스업|모카신|블로퍼|플랫|펌프스|슈즈/.test(n)) base='스니커즈';
  else if(/수영복|비치웨어/.test(n)){ base = /가방/.test(n)?'가방':'수영복'; }
  else if(/청바지|데님/.test(n)) base='청바지';
  else if(/반바지|버뮤다|스코츠/.test(n)) base='반바지';
  else if(/스커트/.test(n)) base='스커트';
  else if(/원피스/.test(n)) base='원피스';
  else if(/점프수트/.test(n)) base='점프수트';
  else if(/보디수트/.test(n)) base='보디수트';
  else if(/코디세트/.test(n)) base='세트';
  else if(/블레이저|자켓|재킷/.test(n)) base='자켓';
  else if(/코트아우터|코트|패딩|점퍼|아우터/.test(n)) base='코트';
  else if(/니트|스웨터|가디건|카디건/.test(n)) base='니트';
  else if(/스웨트셔츠|맨투맨|후드/.test(n)) base='맨투맨';
  else if(/폴로/.test(n)) base='카라티셔츠';
  else if(/티셔츠/.test(n)) base='티셔츠';
  else if(/탑/.test(n)) base = g==='W'?'블라우스':'티셔츠';
  else if(/오버셔츠/.test(n)) base='셔츠';
  else if(/수트/.test(n)){ base = /액세서리/.test(n)?'넥타이':'셔츠'; }
  else if(/셔츠|블라우스/.test(n)) base='셔츠';
  else if(/모자|캡|비니|햇/.test(n)) base='모자';
  else if(/벨트/.test(n)) base='벨트';
  else if(/양말|삭스/.test(n)) base='양말';
  else if(/선글라스|아이웨어/.test(n)) base='선글라스';
  else if(/넥타이|타이/.test(n)) base='넥타이';
  else if(/스카프|머플러|목도리|반다나/.test(n)) base='스카프';
  else if(/주얼리|목걸이|귀걸이|반지|팔찌/.test(n)) base='주얼리';
  else if(/액세서리|악세|잡화|소품/.test(n)) base='패션소품';
  else if(/바지|린넨|슬랙스|조거|치노|팬츠/.test(n)) base='슬랙스';
  else base='의류';
  return { gender:g, keyword:(gk?gk+' ':'')+base, base:base };
}

// =========================================================================
// 유형(가먼트 계열) — 상충 카테고리 회피 + 올바른 계열 가점 (수동/자동과 동일)
// =========================================================================
var FAM={
  TOP:/티셔츠|셔츠|블라우스|니트|맨투맨|스웨트|후드|폴로|나시|카디건|상의|탑|t-?shirt|tee|shirt|blouse|knit|sweater|hoodie|polo/i,
  OUTER:/코트|자켓|재킷|점퍼|패딩|블레이저|아우터|야상|바람막이|coat|jacket|blazer|outerwear|parka|padding/i,
  BOTTOM:/바지|팬츠|반바지|청바지|슬랙스|데님|레깅스|조거|치노|숏팬츠|핫팬츠|하의|pants|trouser|jeans|denim|leggings|shorts|slacks|jogger|chino|bottoms/i,
  SKIRT:/스커트|치마|skirt/i,
  DRESS:/원피스|드레스|점프수트|점프슈트|jumpsuit|dress|romper|bodysuit/i,
  SHOES:/신발|스니커즈|운동화|구두|부츠|샌들|슬리퍼|로퍼|힐|슈즈|워킹화|더비|모카신|shoes?|boots?|sneaker|loafer|sandal|slipper|heel|flip ?flop/i,
  BAG:/가방|백팩|클러치|토트|숄더|크로스백|핸드백|파우치|bag|backpack|tote|clutch|handbag|luggage/i,
  ACC:/모자|캡|비니|벨트|양말|선글라스|아이웨어|넥타이|타이|스카프|머플러|목도리|장갑|주얼리|액세서리|악세|패션소품|잡화|acc|hat|\bcap\b|beanie|belt|socks|sunglass|necktie|bow ?tie|scarf|jewelry|accessor/i,
  SWIM:/수영|비치|스윔|비키니|래시가드|보드숏|swim|bikini|beach/i
};
var BASE_FAM={'가방':'BAG','스니커즈':'SHOES','양말':'ACC','수영복':'SWIM','청바지':'BOTTOM','반바지':'BOTTOM','스커트':'SKIRT','원피스':'DRESS','점프수트':'DRESS','자켓':'OUTER','코트':'OUTER','니트':'TOP','맨투맨':'TOP','카라티셔츠':'TOP','티셔츠':'TOP','블라우스':'TOP','셔츠':'TOP','넥타이':'ACC','슬랙스':'BOTTOM','모자':'ACC','벨트':'ACC','선글라스':'ACC','스카프':'ACC','주얼리':'ACC','패션소품':'ACC'};
var BASE_SYN={
 '반바지':/반바지|숏팬츠|핫팬츠|버뮤다|하프팬츠|치마바지|보드숏|shorts/i,
 '슬랙스':/슬랙스|슬랙|팬츠|바지|치노|조거|린넨|와이드|pants|trouser|slacks|chino|jogger/i,
 '청바지':/청바지|데님|진|jean|denim/i,
 '스커트':/스커트|치마|skirt/i,
 '원피스':/원피스|드레스|dress/i,
 '점프수트':/점프수트|점프슈트|jumpsuit|올인원|롬퍼|romper/i,
 '자켓':/자켓|재킷|블레이저|jacket|blazer/i,
 '코트':/코트|패딩|점퍼|아우터|coat/i,
 '니트':/니트|스웨터|가디건|카디건|knit|sweater|cardigan/i,
 '맨투맨':/맨투맨|스웨트|후드|기모|sweatshirt|hoodie/i,
 '카라티셔츠':/폴로|카라|피케|polo/i,
 '티셔츠':/티셔츠|t-?shirt|tee/i,
 '블라우스':/블라우스|셔츠|탑|blouse|shirt/i,
 '셔츠':/셔츠|블라우스|shirt|blouse/i,
 '가방':/가방|백팩|토트|숄더|크로스|클러치|핸드백|파우치|bag|backpack|tote|handbag/i,
 '스니커즈':/스니커즈|운동화|신발|슈즈|스니커|구두|부츠|샌들|로퍼|워킹화|sneaker|shoes|boots|loafer/i,
 '넥타이':/넥타이|necktie|bow ?tie|cravat/i,
 '벨트':/벨트|belt/i,
 '모자':/모자|캡|비니|햇|hat|\bcap\b|beanie/i,
 '선글라스':/선글라스|아이웨어|sunglass|eyewear/i,
 '스카프':/스카프|머플러|목도리|반다나|scarf|muffler/i,
 '주얼리':/주얼리|목걸이|귀걸이|반지|팔찌|jewelry|necklace|earring/i,
 '양말':/양말|삭스|socks/i,
 '수영복':/수영복|비키니|스윔|비치|래시가드|swim|bikini/i,
 '패션소품':/소품|잡화|액세서리|악세|accessor/i
};
function famOfBase(base){ return BASE_FAM[base]||null; }
function famsOf(text){ var r=[]; for(var k in FAM){ if(FAM[k].test(text)) r.push(k); } return r; }
function conflictFam(base, text){
  var ef=famOfBase(base); if(!ef || !text) return false;
  var fams=famsOf(text);
  if(fams.indexOf(ef)>=0) return false;
  return fams.length>0;
}
var FAM_KW={BOTTOM:'바지',DRESS:'원피스',SKIRT:'스커트',OUTER:'자켓',TOP:'상의',SHOES:'신발',BAG:'가방',SWIM:'수영복'};
function famGeneralKw(base, gender){
  var ef=famOfBase(base); if(!ef || !FAM_KW[ef]) return null;
  var g = gender==='W' ? '여성 ' : (gender==='M' ? '남성 ' : '');
  return g+FAM_KW[ef];
}
var ENGLISH_MARKETS={SHOPEE:1, MUSTIT:1};
var ENG_BASE={'가방':'bag','스니커즈':'sneakers','반바지':'shorts','슬랙스':'pants','청바지':'jeans','스커트':'skirt','원피스':'dress','점프수트':'jumpsuit','보디수트':'bodysuit','자켓':'jacket','코트':'coat','니트':'knit','맨투맨':'sweatshirt','카라티셔츠':'polo','티셔츠':'t-shirt','블라우스':'blouse','셔츠':'shirt','넥타이':'necktie','벨트':'belt','모자':'hat','선글라스':'sunglasses','스카프':'scarf','주얼리':'jewelry','양말':'socks','수영복':'swimwear'};
function engKws(base){ var e=ENG_BASE[base]; return e?[e]:[]; }

// =========================================================================
// 규칙: 후보 카테고리 텍스트가 이 마켓·성별에 허용되는가 (수동/자동과 동일)
// =========================================================================
function acceptable(market, text, gender){
  if(!text) return false;
  if(FORBIDDEN.test(text)) return false;
  if(PET.test(text)) return false;
  if(INVALID_MARK.test(text)) return false;
  if(market==='11ST' && ELEVEN_FORBIDDEN.test(text)) return false;
  if((market==='AUC20'||market==='GMK20') && /브랜드/.test(text)) return false;
  var hasW=/여성|여자|Women|Woman|레이디|Ladies/i.test(text);
  var hasM=/남성|남자|\bMen\b|\bMan\b/i.test(text);
  if(gender==='W' && hasM && !hasW) return false;
  if(gender==='M' && hasW && !hasM) return false;
  return true;
}
// 후보 점수. ★단계형(ABC=국내 사업자): 11번가는 '국내' 카테고리 우선(해외 감점) — 수동/자동과 반대.
function catScore(market, text, gender, base){
  var s=0;
  if(market==='11ST'){ if(/해외/.test(text)) s-=6; else s+=3; } // ★국내 우선
  var ef=famOfBase(base);
  if(ef){ var fams=famsOf(text); if(fams.indexOf(ef)>=0) s+=4; else if(fams.length) s-=3; }
  if(base && text.indexOf(base)>=0) s+=2;
  var syn=BASE_SYN[base]; if(syn && syn.test(text)) s+=2;
  if(gender==='W' && /여성|Women/i.test(text)) s+=1;
  if(gender==='M' && /남성|Men/i.test(text)) s+=1;
  if(/fashion|apparel|clothes|clothing|\bbags?\b|shoes?|의류|여성복|남성복|잡화|신발|구두/i.test(text)) s+=1;
  if(/automobile|motorcycle|beauty|makeup|\bhome\b|grocery|food|stationery|hair access|utilities|sports ?& ?outdoor recreation/i.test(text)) s-=2;
  var depth=(text.match(/>/g)||[]).length; s += Math.min(depth,4)*0.25;
  return s;
}
function pickBest(market, opts, gender, base){
  var ok=opts.filter(function(o){ return acceptable(market, o.text, gender); });
  if(!ok.length) return null;
  ok.sort(function(a,b){ return catScore(market,b.text,gender,base)-catScore(market,a.text,gender,base); });
  return ok[0];
}

// =========================================================================
// 설정(카테고리설정) 페이지 동작 (수동/자동과 동일)
// =========================================================================
function listOpts(market){
  var sel=document.getElementById('openmarket_category_search_list_'+market);
  if(!sel) return {sel:null, opts:[]};
  return { sel:sel, opts:Array.prototype.slice.call(sel.options).map(function(o,i){ return {i:i, text:(o.text||'').trim(), val:o.value}; }).filter(function(o){ return o.text.indexOf('>')>=0; }) };
}
function doSearch(market, keyword){
  var inp=document.getElementById('openmarket_category_search_text_'+market);
  if(!inp) return false;
  inp.value=keyword;
  try{ search_category(market,'openmarket_category_search_list_'+market,''); }catch(e){ return false; }
  return true;
}
async function waitAutomap(){
  var t0=Date.now();
  while(Date.now()-t0<25000){
    var a=listOpts('AUC20').opts.length, b=listOpts('SMART').opts.length, c=listOpts('COUP').opts.length;
    if(a>0 && b>0 && c>0) return true;
    await sleep(700);
  }
  return false;
}
async function waitSearch(market, prevSig){
  var t0=Date.now();
  while(Date.now()-t0<8000){
    var opts=listOpts(market).opts;
    var sig=opts.map(function(o){return o.text;}).join('|');
    if(opts.length && sig!==prevSig && !/검색중/.test(sig)) return opts;
    await sleep(500);
  }
  return listOpts(market).opts;
}

// ---- 고시 상품군(notify_group) 보장 (수동/자동과 동일) ----
var NOTIFY_EXEMPT={CAFE24:1,MUSTIT:1,HAKYUNG:1,REEBONZ:1,BALAAN:1,TRENBE:1,SHOPEE:1,QOO10JP:1,SHOPIFY:1};
function needsNotify(market){ return !NOTIFY_EXEMPT[market]; }
function hasCategory(market){ var sel=document.getElementById('openmarket_category_search_list_'+market); return !!(sel && sel.value && sel.value!=='no_category'); }
function groupSet(market){ var g=document.getElementById('notify_group_no_'+market); return !!(g && g.value); }
function marketsNeedingGroup(){ return MARKETS.filter(function(m){ return needsNotify(m) && hasCategory(m); }); }
async function waitNotifyGroups(timeout){
  var t0=Date.now();
  while(Date.now()-t0<(timeout||9000)){
    var pend=marketsNeedingGroup().filter(function(m){ return !groupSet(m); });
    if(!pend.length) return true;
    await sleep(600);
  }
  return false;
}
function groupPrefFor(base){
  if(/가방|벨트|모자|선글라스|스카프|주얼리|양말|패션소품|넥타이/.test(base)) return ['패션잡화','잡화','패션잡화 (모자/벨트/액세서리)','기타 재화'];
  if(/스니커즈|신발|구두/.test(base)) return ['구두/신발','신발','구두','기타 재화'];
  return ['의류','패션의류','기타 재화'];
}
function ensureNotifyGroups(cls){
  var prefs=groupPrefFor(cls?cls.base:'');
  var setM=[];
  marketsNeedingGroup().forEach(function(m){
    var g=document.getElementById('notify_group_no_'+m);
    if(!g || g.value) return;
    var idx=-1;
    for(var p=0;p<prefs.length && idx<0;p++){
      for(var i=0;i<g.options.length;i++){ if((g.options[i].text||'').trim()===prefs[p]){ idx=i; break; } }
    }
    if(idx<0){ for(var j=0;j<g.options.length;j++){ if(/의류|잡화|기타\s*재화/.test(g.options[j].text||'')){ idx=j; break; } } }
    if(idx<0){ for(var k=0;k<g.options.length;k++){ if(g.options[k].value){ idx=k; break; } } }
    if(idx>=0){ g.selectedIndex=idx; g.dispatchEvent(new Event('change',{bubbles:true})); setM.push(m); }
  });
  return setM;
}
function applyNotifyRefer(markets){
  (markets||[]).forEach(function(m){
    var master=document.getElementById(m+'_input_notify');
    if(!master) return;
    if(!master.checked){ master.checked=true; }
    try{
      if(typeof chk_refer==='function'){ chk_refer('all', master, m+'_input_notify', '상품상세페이지 참조'); }
      else { master.dispatchEvent(new Event('click',{bubbles:true})); }
    }catch(e){}
  });
}

function bestFromFull(market, gender, base){
  var s=document.getElementById('openmarket_category_search_list2_'+market);
  if(!s || s.options.length<10) return null;
  var opts=Array.prototype.slice.call(s.options).map(function(o){ return {text:(o.text||'').trim(), val:o.value}; }).filter(function(o){ return o.text.indexOf('>')>=0; });
  var ok=opts.filter(function(o){ return acceptable(market, o.text, gender); });
  if(!ok.length) return null;
  ok.sort(function(a,b){ return catScore(market,b.text,gender,base)-catScore(market,a.text,gender,base); });
  return ok[0];
}
function commitInject(market, cand){
  var sel=document.getElementById('openmarket_category_search_list_'+market);
  if(!sel) return false;
  var o=document.createElement('option'); o.value=cand.val; o.text=cand.text;
  sel.appendChild(o); sel.value=cand.val;
  sel.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}
function bestOfPool(pool, market, gender, base){
  if(!pool.length) return null;
  pool.sort(function(a,b){ return catScore(market,b.text,gender,base)-catScore(market,a.text,gender,base); });
  return pool[0];
}
async function processMarket(market, cls, chosenLog){
  var base=cls.base, gender=cls.gender;
  var cur=listOpts(market);
  if(!cur.sel){ return; }
  var pool=[];
  cur.opts.forEach(function(o){ if(acceptable(market,o.text,gender)) pool.push({text:o.text, val:o.val}); });
  var autoBest=bestOfPool(pool.slice(), market, gender, base);
  var smartRefine=(market==='SMART' && (famOfBase(base)==='SHOES'||famOfBase(base)==='ACC'));
  // 11번가는 국내 카테고리 우선이라 automap 추천이 해외를 골랐으면 국내로 재검색
  var elevenOverseas=(market==='11ST' && autoBest && /해외/.test(autoBest.text));
  var needSearch = !autoBest || conflictFam(base, autoBest.text) || smartRefine || elevenOverseas;
  if(needSearch){
    var kws=[cls.keyword, famGeneralKw(base,gender), base, famGeneralKw(base,'')];
    if(ENGLISH_MARKETS[market]) kws=kws.concat(engKws(base));
    kws=kws.filter(function(k,i,a){ return k && a.indexOf(k)===i; });
    for(var ki=0; ki<kws.length; ki++){
      var prev=listOpts(market).opts.map(function(o){return o.text;}).join('|');
      if(!doSearch(market, kws[ki])) continue;
      var opts=await waitSearch(market, prev);
      opts.forEach(function(o){ if(acceptable(market,o.text,gender)) pool.push({text:o.text, val:o.val}); });
      var cb=bestOfPool(pool.slice(), market, gender, base);
      if(cb && !conflictFam(base, cb.text) && catScore(market,cb.text,gender,base)>=6) break;
    }
  }
  var winner=bestOfPool(pool, market, gender, base);
  if(!winner || conflictFam(base, winner.text)){
    var full=bestFromFull(market, gender, base);
    if(full && (!winner || catScore(market,full.text,gender,base)>catScore(market,winner.text,gender,base))) winner=full;
  }
  if(winner){
    commitInject(market, winner);
    chosenLog[MLABEL[market]] = winner.text;
  } else {
    var keep=listOpts(market); var cs=keep.sel? (keep.sel.options[keep.sel.selectedIndex]||{}).text:'';
    chosenLog[MLABEL[market]] = '(유지)'+(cs||'').trim();
  }
}

function serializeForm(form){
  var fd=new FormData(form);
  var p=new URLSearchParams();
  fd.forEach(function(v,k){ if(typeof v==='string') p.append(k,v); });
  return p;
}

async function processLeaf(state){
  var item=state.queue[state.idx];
  var name=item.name||'';
  var cls=classify(name);
  setStat('['+(state.idx+1)+'/'+state.queue.length+'] '+name+' — 자동매핑 실행...');

  var aiBtn=Array.prototype.slice.call(document.querySelectorAll('a,button,input')).find(function(x){
    var oc=(x.getAttribute&&x.getAttribute('onclick'))||''; return oc.indexOf('search_recommend_category_all')>=0 || /자동\s*매핑\s*시작/.test(x.textContent||x.value||'');
  });
  _alerts.length=0;
  try{ if(typeof search_recommend_category_all==='function') search_recommend_category_all(aiBtn||{}); }catch(e){}
  await waitAutomap();

  var chosen={};
  for(var i=0;i<MARKETS.length;i++){ await processMarket(MARKETS[i], cls, chosen); }

  setStat('['+(state.idx+1)+'/'+state.queue.length+'] '+name+' — 고시 상품군/참조 처리...');
  await waitNotifyGroups(9000);
  var setM=ensureNotifyGroups(cls);
  var referTargets=[];
  [].concat(setM, ['11ST','LTON']).forEach(function(m){ if(referTargets.indexOf(m)<0 && !NOTIFY_EXEMPT[m] && hasCategory(m)) referTargets.push(m); });
  if(referTargets.length){ await sleep(1500); applyNotifyRefer(referTargets); await sleep(500); }

  var rec={id:item.id, name:name, kw:cls.keyword, chosen:chosen};

  if(state.dry){
    rec.saved=false;
    try{ rec.formCheck=(typeof form_check==='function')?form_check():''; }catch(e){ rec.formCheck='ERR'; }
    state.log.push(rec); state.ok++;
    setStat('[테스트] '+name+' 매핑 계산 완료(저장 안 함)'+(rec.formCheck?(' · 검증경고: '+rec.formCheck):''));
    return true;
  }

  var form=document.market_category || document.querySelector('form[name=market_category]');
  var fc=''; try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; }
  if(fc){ ensureNotifyGroups(cls); await sleep(1500); applyNotifyRefer(marketsNeedingGroup()); await sleep(600); try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; } }
  if(fc){ rec.saved=false; rec.err='검증실패: '+fc; state.log.push(rec); state.fail++; setStat('저장검증 실패: '+fc); return false; }
  try{
    var body=serializeForm(form);
    var action=new URL(form.getAttribute('action')||'admin_category_ok.php', location.href).href;
    var resp=await fetch(action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:body.toString()});
    var ok=resp.status===200;
    rec.saved=ok; if(!ok) rec.err='HTTP '+resp.status;
    state.log.push(rec);
    if(ok){ state.ok++; } else { state.fail++; }
    return ok;
  }catch(e){ rec.saved=false; rec.err=String(e); state.log.push(rec); state.fail++; return false; }
}

// =========================================================================
// 카테고리설정 페이지: 큐 항목 순차 처리
// =========================================================================
function setUrl(state, item){ return DIR()+'admin_category_set.php?category_id='+item.id+'&ps_uid='+(state.psUid||'')+'&tm='; }

async function runSetPage(){
  var state=gs();
  if(!state || !state.running) return;
  var m=location.search.match(/category_id=(\d+)/);
  var curId=m?m[1]:null;
  if(state.idx>=state.queue.length){ finish(state); return; }
  var want=state.queue[state.idx];
  if(curId!==String(want.id)){ location.href=setUrl(state, want); return; }
  panelSet(state);
  await sleep(1200);
  if(!gs() || !gs().running){ stopHere(state, '정지되었습니다.'); return; }
  if(state.max && (state.ok+state.fail)>=state.max){ finish(state, true); return; }
  await processLeaf(state);
  var latest=gs();
  if(latest && latest.running===false){ state.idx++; stopHere(state, '정지되었습니다 — 성공 '+state.ok+' · 실패 '+state.fail); return; }
  state.idx++; ss(state); panelSet(state);
  if(state.idx>=state.queue.length){ finish(state); return; }
  if(state.max && (state.ok+state.fail)>=state.max){ finish(state, true); return; }
  await sleep(400);
  location.href=setUrl(state, state.queue[state.idx]);
}

function stopHere(state, msg){
  state.running=false; ss(state);
  setStat(msg||'정지되었습니다.');
  try{ console.log('[TMG 단계형매핑] 정지 — 결과 로그:', JSON.stringify(state.log,null,1)); }catch(e){}
  if(location.pathname.indexOf('admin_category_set.php')>=0){
    setTimeout(function(){ location.href=DIR()+'admin_category_new.php'; }, 1200);
  }
}
function finish(state, stoppedByMax){
  state.running=false; ss(state);
  var msg='완료 — 총 '+state.queue.length+' | 성공 '+state.ok+' · 실패 '+state.fail+(stoppedByMax?' (테스트 개수 도달)':'');
  setStat(msg);
  try{ console.log('[TMG 단계형매핑] 결과 로그:', JSON.stringify(state.log,null,1)); }catch(e){}
  if(location.pathname.indexOf('admin_category_set.php')>=0){
    setTimeout(function(){ location.href=DIR()+'admin_category_new.php'; }, 1500);
  }
}

// =========================================================================
// 트리 페이지(admin_category_new.php): 사이트 선택 + 리프 fetch-DFS 열거 + 시작 패널
// =========================================================================
function shortOf(full){ var s=String(full||''); while(s.length>3 && s.slice(-3)==='000') s=s.slice(0,-3); return s; }
function useMarketParam(){ var e=document.getElementById('use_market'); var v=e?(e.value||e.textContent||''):''; return (v&&v.indexOf('[')>=0)?v:USE_MARKET_DEFAULT; }

// 트리 페이지의 사이트 목록(THE MANGO 제외)
function listSites(){
  var out=[];
  Array.prototype.slice.call(document.querySelectorAll('#setCateCd1 li')).forEach(function(li){
    var sp=li.querySelector('span[id]')||li.querySelector('[id]');
    var full=sp?sp.id:''; var name=(li.textContent||'').replace(/\s+/g,'').trim();
    if(!full || /^0+$/.test(full)) return;            // THE MANGO(코드 0)/헤더 제외
    if(/themango|더망고|THEMANGO|MANGO/i.test(name)) return;
    out.push({name:name, full:full, short:shortOf(full)});
  });
  return out;
}

async function catGetChildren(short){
  var g=short.length/3;
  var body='mode=category_get&category_depth='+(g+1)+'&category_id='+encodeURIComponent(short)+'&themango=';
  var html=await fetch(DIR()+'admin_category_get_load.php',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body}).then(function(r){return r.text();});
  var doc=new DOMParser().parseFromString(html,'text/html');
  return Array.prototype.slice.call(doc.querySelectorAll('li')).map(function(li){
    var sp=li.querySelector('[id]'); if(!sp) return null;
    return { full:sp.id, name:(sp.textContent||'').replace(/\s+/g,' ').trim() };
  }).filter(Boolean);
}
// MEN/WOMEN → 성별 정규화(분류기가 인식하도록). 그 외 이름은 그대로.
function normName(n){ if(/^MEN$/i.test(n)||/남성/.test(n)) return '남성'; if(/^WOMEN$/i.test(n)||/여성/.test(n)) return '여성'; return n; }

// 사이트 루트에서 전 리프 열거. leaf = 자식이 없는 노드. 경로명을 name으로 구성.
async function enumerateLeaves(siteShort){
  var leaves=[]; var seen={}; var nodes=0; var t0=Date.now();
  async function dfs(node, pathNames){
    if(Date.now()-t0>180000) return; // 3분 안전 상한
    nodes++;
    if(nodes%15===0) setStat('리프 탐색 중... (노드 '+nodes+' · 리프 '+leaves.length+')');
    var kids;
    try{ kids=await catGetChildren(shortOf(node.full)); }catch(e){ kids=[]; }
    if(!kids.length){
      if(!seen[node.full]){ seen[node.full]=1; leaves.push({ id:node.full, name:pathNames.join(' ') }); }
      return;
    }
    for(var i=0;i<kids.length;i++){
      await dfs(kids[i], pathNames.concat(normName(kids[i].name)));
    }
  }
  var roots=await catGetChildren(siteShort);
  for(var i=0;i<roots.length;i++){ await dfs(roots[i], [normName(roots[i].name)]); }
  return leaves;
}

// 첫 리프의 show_category에서 ps_uid 추출(사이트 공통값). 실패 시 null.
async function fetchPsUid(leafFull){
  try{
    var body='mode=show_category&category_id='+encodeURIComponent(shortOf(leafFull))+'&use_market='+encodeURIComponent(useMarketParam())+'&themango=&pg=1&list_num=10';
    var html=await fetch(DIR()+'admin_category_get_load.php',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body}).then(function(r){return r.text();});
    var m=html.match(/categorySet\(([^)]*)\)/);
    if(m){ var a=m[1].split(',').map(function(s){return s.trim().replace(/^'|'$/g,'');}); return a[2]||null; }
  }catch(e){}
  return null;
}

async function startRun(){
  _stopStart=false;
  var siteVal=(q('#tmgStSite')&&q('#tmgStSite').value)||'';
  var sites=listSites();
  var site=sites.filter(function(s){return s.short===siteVal;})[0]||sites[0];
  if(!site){ setStat('대상 사이트가 없습니다(THE MANGO 제외).'); return; }
  setStat('['+site.name+'] 리프 카테고리 탐색 중...');
  var leaves;
  try{ leaves=await enumerateLeaves(site.short); }catch(e){ setStat('탐색 실패: '+e.message); return; }
  if(_stopStart){ setStat('정지했습니다.'); return; }
  if(!leaves.length){ setStat('리프 카테고리를 찾지 못했습니다.'); return; }
  setStat('ps_uid 확인 중...');
  var psUid=await fetchPsUid(leaves[0].id);
  if(!psUid){ setStat('ps_uid를 확인하지 못했습니다. 중단합니다.'); return; }
  var dry=q('#tmgStDry') && q('#tmgStDry').checked;
  var maxv=parseInt((q('#tmgStMax') && q('#tmgStMax').value)||'0',10)||0;
  if(!_nativeConfirm('['+site.name+'] 리프 '+leaves.length+'개를 '+(dry?'[테스트: 저장 안 함]':'[실제 저장]')+'으로 매핑합니다.'+(maxv?(' (앞 '+maxv+'개만)'):'')+'\nps_uid='+psUid+' · 진행할까요?')){ setStat('취소됨'); return; }
  if(_stopStart){ setStat('정지했습니다.'); return; }
  ss({running:true, dry:!!dry, idx:0, ok:0, fail:0, skip:0, max:maxv, psUid:psUid, site:site.name, queue:leaves, log:[]});
  location.href=DIR()+'admin_category_set.php?category_id='+leaves[0].id+'&ps_uid='+psUid+'&tm=';
}

// =========================================================================
// UI
// =========================================================================
function setStat(m){ var s=q('#tmgStStat'); if(s) s.textContent=m; var s2=q('#tmgStStat2'); if(s2) s2.textContent=m; }
function panelList(){
  if(q('#tmgStPanel')) return;
  var sites=listSites();
  var opts=sites.map(function(s){ return '<option value="'+s.short+'">'+s.name+'</option>'; }).join('');
  var p=document.createElement('div'); p.id='tmgStPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #16a085;border-radius:8px;padding:10px 12px;width:310px;font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold;margin-bottom:6px">카테고리매핑 단계형 자동</div>'
   +'<div style="margin-bottom:4px">사이트: <select id="tmgStSite">'+opts+'</select> <span style="color:#888">(THE MANGO 제외)</span></div>'
   +'<div style="margin-bottom:4px"><label><input type="checkbox" id="tmgStDry" checked> 테스트(저장 안 함)</label></div>'
   +'<div style="margin-bottom:4px">앞에서 <input id="tmgStMax" type="number" value="3" min="0" style="width:50px"> 개만 (0=전체)</div>'
   +'<button id="tmgStGo">리프 탐색 &amp; 시작</button> <button id="tmgStStop" style="color:#d9534f">정지</button>'
   +'<div id="tmgStStat" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">※ 리프 열거 후 카테고리설정 페이지를 순차 이동하며 처리합니다. 11번가는 국내 카테고리로 매핑. 결과는 콘솔(F12)에 기록됩니다.</div>';
  document.body.appendChild(p);
  q('#tmgStGo').onclick=startRun;
  q('#tmgStStop').onclick=function(){ _stopStart=true; var s=gs(); if(s){ s.running=false; ss(s); } setStat('정지했습니다.'); };
}
function panelSet(state){
  if(q('#tmgStMini')) { return; }
  var p=document.createElement('div'); p.id='tmgStMini';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #16a085;border-radius:8px;padding:8px 10px;width:300px;font:12px/1.5 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold">단계형매핑 진행중'+(state.dry?' [테스트]':'')+(state.site?(' · '+state.site):'')+'</div><div id="tmgStStat2" style="margin-top:6px;color:#333;min-height:32px"></div>'
   +'<button id="tmgStStop2" style="color:#d9534f;margin-top:6px">정지</button>';
  document.body.appendChild(p);
  q('#tmgStStop2').onclick=function(){ var s=gs(); if(s){ s.running=false; ss(s); } setStat('정지 요청됨 — 현재 항목 후 멈춥니다.'); };
}

function boot(){
  if(location.pathname.indexOf('admin_category_new.php')>=0){ panelList(); }
  else if(location.pathname.indexOf('admin_category_set.php')>=0){ var s2=gs(); if(s2&&s2.running){ panelSet(s2); runSetPage(); } }
}
if(document.readyState==='complete') boot();
else window.addEventListener('load', boot);
})();
