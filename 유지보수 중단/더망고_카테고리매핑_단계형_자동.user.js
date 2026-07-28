// ==UserScript==
// @name         더망고 카테고리매핑 단계형 자동(사이트 트리 순차 + 규칙기반 검수)
// @namespace    solddeul.tmg
// @version      1.4
// @description  단계형 카테고리매핑(admin_category_new.php) 자동화. 사이트(기본 ABC마트)의 카테고리 트리를 admin_category_get_load.php로 fetch-DFS해 모든 최소단위(리프) 카테고리를 열거하고, 각 리프의 카테고리설정 팝업(admin_category_set.php?category_id=..)을 순차로 열어 AI자동매핑→11개 마켓 규칙 재선택(11번가=국내)→고시→fetch-POST 저장. 매핑 팝업 로직은 "카테고리매핑(수동/자동)" 매크로와 동일. THE MANGO 사이트는 제외. localStorage로 새로고침을 넘어 진행. 테스트(저장 안 함) 모드 지원. v1.1: ★평가를 "서버 실제 저장값 되읽기"로 개선 — 리프 고유 ps_uid로 admin_category_set.php를 fetch해 마켓별 실제 저장 카테고리를 읽어 평가하므로 [A] "카테고리를 변경해주세요" 무효표시를 정확히 검출(로그 기반 평가는 매크로가 '고른' 값이라 저장 후 서버가 내리는 무효판정을 놓쳤음). v1.2: ★신발 소분류 규칙 개선 — classify가 모든 신발을 스니커즈로 뭉개던 것을 로퍼/구두/부츠/샌들/슬리퍼/힐/플랫/운동화로 세분화(검색어·스코어 정확도↑). SMART가 비-리프(예: 남성신발>구두)를 저장 거부해 [A] 무효가 나던 것을 유효 리프(구두>로퍼)로, 11번가 해외를 국내(남성화/여성화)로, 성별불일치를 교정. 마지막 세그 정확일치 보너스 추가. v1.3: [A]무효·[G]미매핑 집중 — SMART는 automap의 낡은 트리 대신 검색결과(현재 트리)만 사용해 "카테고리를 변경해주세요" 무효 저장을 차단, 11번가는 국내 "남성화/여성화" 폴백 키워드로 미매핑 방지, 신발관리용품(부츠키퍼 등)·비-신발 트리(파마약>레인부츠 등) 감점. v1.4: ★검토기준(평가) 강화 — 유형검사를 전체경로가 아닌 '리프' 기준으로 보강해, 중간노드 '스포츠의류/운동화'·'운동화끈'의 '운동화'에 가려지던 비-신발 오분류([I]: 의류·양말·신발끈·깔창·키즈·청바지 등)를 정확히 검출. 한글 '키즈/주니어'도 금지어에 추가.
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
var _busy=false;   // startRun 재진입 방지(버튼 중복 클릭 시 스레드 2개 방지)
var MARKETS=['AUC20','GMK20','11ST','SMART','COUP','LTON','LFMALL','MUSTIT','SHOPEE','QOO10JP','PLAYAUTO'];
var MLABEL={AUC20:'옥션',GMK20:'G마켓','11ST':'11번가',SMART:'스마트스토어',COUP:'쿠팡',LTON:'롯데ON',LFMALL:'LF몰',MUSTIT:'머스트잇',SHOPEE:'쇼피',QOO10JP:'큐텐JP',PLAYAUTO:'플레이오토'};
// 트리 로드 시 서버로 넘기는 use_market(15종). 페이지의 #use_market 값을 우선 사용, 없으면 이 상수.
var USE_MARKET_DEFAULT='["AUC20","GMK20","11ST","SMART","COUP","LTON","LFMALL","MUSTIT","SHOPEE","QOO10JP","SHOPIFY","CAFE24","GODO","IMWEB","PLAYAUTO"]';

var FORBIDDEN=/(어린이|유아|아동|키즈|주니어|도서|서적|e쿠폰|모바일|렌탈|렌터카|배달음식|출산|육아|임산부|임부|위생용품|의료기기|의약품|Baby|Kids|Toddler|Infant|Children|Maternity)/i;
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
  else if(/신발|스니커즈|운동화|구두|부츠|샌들|슬리퍼|로퍼|힐|워킹화|더비|레이스업|모카신|블로퍼|플랫|펌프스|슈즈|워커|메리제인|슬립온|아쿠아|농구화|골프화|등산화|트레일/.test(n)){
    // ★ABC마트=전부 신발. 소분류 토큰으로 base 세분화(검색어·스코어 정확도↑; 안 맞으면 스니커즈).
    if(/부츠|워커|앵클|첼시|롱부츠|미들부츠|하프부츠|레인부츠/.test(n)) base='부츠';
    else if(/로퍼|모카신|옥스퍼드|블로퍼/.test(n)) base='로퍼';
    else if(/더비|레이스업|정장화/.test(n)) base='구두';
    else if(/힐|펌프스|웨지/.test(n)) base='힐';
    else if(/플랫|메리제인|발레/.test(n)) base='플랫';
    else if(/슬리퍼|뮬|조리|쪼리/.test(n)) base='슬리퍼';
    else if(/샌들|슬라이드|코르크|플립플랍|텅|클로그|아쿠아|젤리|글래디/.test(n)) base='샌들';
    else if(/농구화|러닝화|워킹화|골프화|등산화|트레일|축구화|테니스화|배구화|트레킹|기능화/.test(n)) base='운동화';
    else if(/구두/.test(n)) base='구두';
    else base='스니커즈';
  }
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
var BASE_FAM={'가방':'BAG','스니커즈':'SHOES','로퍼':'SHOES','구두':'SHOES','부츠':'SHOES','샌들':'SHOES','슬리퍼':'SHOES','힐':'SHOES','플랫':'SHOES','운동화':'SHOES','양말':'ACC','수영복':'SWIM','청바지':'BOTTOM','반바지':'BOTTOM','스커트':'SKIRT','원피스':'DRESS','점프수트':'DRESS','자켓':'OUTER','코트':'OUTER','니트':'TOP','맨투맨':'TOP','카라티셔츠':'TOP','티셔츠':'TOP','블라우스':'TOP','셔츠':'TOP','넥타이':'ACC','슬랙스':'BOTTOM','모자':'ACC','벨트':'ACC','선글라스':'ACC','스카프':'ACC','주얼리':'ACC','패션소품':'ACC'};
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
 '로퍼':/로퍼|모카신|옥스퍼드|블로퍼|loafer|moccasin|oxford/i,
 '구두':/구두|더비|레이스업|정장화|드레스슈즈|플랫슈즈|로퍼|dress ?shoe|derby|oxford|loafer/i,
 '부츠':/부츠|워커|앵클|첼시|롱부츠|레인부츠|boot|walker|chelsea/i,
 '샌들':/샌들|슬라이드|코르크|플립플랍|조리|클로그|아쿠아|젤리|글래디|sandal|slide|clog|aqua/i,
 '슬리퍼':/슬리퍼|뮬|블로퍼|조리|slipper|mule/i,
 '힐':/힐|펌프스|웨지|heel|pumps|wedge/i,
 '플랫':/플랫|메리제인|발레|flat|mary ?jane|ballet/i,
 '운동화':/운동화|농구화|러닝화|워킹화|골프화|등산화|트레일|스니커즈|sneaker|running|walking|hiking/i,
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
var ENG_BASE={'가방':'bag','스니커즈':'sneakers','로퍼':'loafers','구두':'dress shoes','부츠':'boots','샌들':'sandals','슬리퍼':'slippers','힐':'heels','플랫':'flats','운동화':'sneakers','반바지':'shorts','슬랙스':'pants','청바지':'jeans','스커트':'skirt','원피스':'dress','점프수트':'jumpsuit','보디수트':'bodysuit','자켓':'jacket','코트':'coat','니트':'knit','맨투맨':'sweatshirt','카라티셔츠':'polo','티셔츠':'t-shirt','블라우스':'blouse','셔츠':'shirt','넥타이':'necktie','벨트':'belt','모자':'hat','선글라스':'sunglasses','스카프':'scarf','주얼리':'jewelry','양말':'socks','수영복':'swimwear'};
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
  if(/화장품|미용|헤어|파마|스노보드|스키장비|스쿠버|낚시|욕실|생활\/건강|악기|자동차용품|신발용품|슈케어|키퍼|깔창|인솔|구두약/.test(text)) s-=6;  // ★비-신발 트리/신발관리용품(파마약>레인부츠·신발용품>부츠키퍼 등) 강감점
  var depth=(text.match(/>/g)||[]).length; s += Math.min(depth,4)*0.25;
  var segs=text.split('>'); var last=(segs[segs.length-1]||'').trim();
  if(base && last===base) s+=1.5;  // ★마지막 세그=base 정확일치만 가점(‘부츠키퍼’ 같은 용품 오선택 방지)
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
  var searchPool=[];  // ★검색결과(현재 트리)만 별도 수집
  cur.opts.forEach(function(o){ if(acceptable(market,o.text,gender)) pool.push({text:o.text, val:o.val}); });
  var autoBest=bestOfPool(pool.slice(), market, gender, base);
  var smartRefine=(market==='SMART' && (famOfBase(base)==='SHOES'||famOfBase(base)==='ACC'));
  // 11번가는 국내 카테고리 우선이라 automap 추천이 해외를 골랐으면 국내로 재검색
  var elevenOverseas=(market==='11ST' && autoBest && /해외/.test(autoBest.text));
  // ★SMART automap 추천 트리는 낡아(예: '남성신발>부츠', '샌들>아쿠아샌들') SMART가 저장을 거부(무효표시)함 → 항상 검색해 현재 트리만 사용
  var needSearch = !autoBest || conflictFam(base, autoBest.text) || smartRefine || elevenOverseas;
  if(needSearch){
    var kws=[cls.keyword, famGeneralKw(base,gender), base, famGeneralKw(base,'')];
    // ★11번가 폴백: 국내 신발은 '남성화/여성화' 트리에 있음 → 소분류 검색이 비면 이걸로 채워 미매핑 방지. (SMART엔 금지: '남성화'=화장품)
    if(market==='11ST'){ if(gender==='M') kws.push('남성화'); else if(gender==='W') kws.push('여성화'); else { kws.push('남성화','여성화'); } }
    if(ENGLISH_MARKETS[market]) kws=kws.concat(engKws(base));
    kws=kws.filter(function(k,i,a){ return k && a.indexOf(k)===i; });
    for(var ki=0; ki<kws.length; ki++){
      var prev=listOpts(market).opts.map(function(o){return o.text;}).join('|');
      if(!doSearch(market, kws[ki])) continue;
      var opts=await waitSearch(market, prev);
      opts.forEach(function(o){ if(acceptable(market,o.text,gender)){ pool.push({text:o.text, val:o.val}); searchPool.push({text:o.text, val:o.val}); } });
      var cbPool = (market==='SMART') ? searchPool : pool;   // 조기중단 판정은 실제 선택 풀 기준
      var cb=bestOfPool(cbPool.slice(), market, gender, base);
      if(cb && !conflictFam(base, cb.text) && catScore(market,cb.text,gender,base)>=6) break;
    }
  }
  // ★SMART: 낡은 automap 후보를 버리고 검색결과(현재 트리)만으로 선택 → 무효 저장 방지(검색이 완전히 비면 기존 풀로 폴백)
  var effPool = (market==='SMART' && searchPool.length) ? searchPool : pool;
  var winner=bestOfPool(effPool, market, gender, base);
  if((!winner || conflictFam(base, winner.text)) && market!=='SMART'){   // SMART는 full-list(automap)도 낡음 → 사용 안 함
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
// ★ ps_uid는 리프마다 다르다. 미매핑 리프는 'new'(신규 생성), 기존 매핑 리프는 그 리프의 ps_uid(편집).
function setUrl(item){ return DIR()+'admin_category_set.php?category_id='+item.id+'&ps_uid='+(item.psUid||'new')+'&tm='; }

async function runSetPage(){
  var state=gs();
  if(!state || !state.running) return;
  var m=location.search.match(/category_id=(\d+)/);
  var curId=m?m[1]:null;
  if(state.idx>=state.queue.length){ finish(state); return; }
  var want=state.queue[state.idx];
  if(curId!==String(want.id)){ location.href=setUrl(want); return; }
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
  location.href=setUrl(state.queue[state.idx]);
}

function stopHere(state, msg){
  state.running=false; state.exportPending=true; ss(state);
  setStat(msg||'정지되었습니다.');
  try{ console.log('[TMG 단계형매핑] 정지 — 결과 로그:', JSON.stringify(state.log,null,1)); }catch(e){}
  if(location.pathname.indexOf('admin_category_set.php')>=0){
    setTimeout(function(){ location.href=DIR()+'admin_category_new.php'; }, 1200);
  }
}
function finish(state, stoppedByMax){
  state.running=false; state.exportPending=true; ss(state);
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

// ★ 리프의 매핑 상태 확인(리프마다 개별). show_category 응답에 기존 매핑행(categorySet ps_uid=숫자)이 있으면
//   mapped=true + 그 ps_uid(편집용), 없으면 미매핑 → ps_uid='new'(신규 생성).
//   (예전 버그: 첫 리프의 ps_uid 하나를 전 리프에 재사용 → 다른 리프 저장이 그 한 매핑만 덮어써서 대량 누락)
async function leafInfo(leafFull){
  try{
    var body='mode=show_category&category_id='+encodeURIComponent(shortOf(leafFull))+'&use_market='+encodeURIComponent(useMarketParam())+'&themango=&pg=1&list_num=10';
    var html=await fetch(DIR()+'admin_category_get_load.php',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body}).then(function(r){return r.text();});
    var m=html.match(/categorySet\('(\d+)','([^']*)','([^']*)'/);
    if(m && /^\d+$/.test(m[3])) return { mapped:true, psUid:m[3] };
  }catch(e){}
  return { mapped:false, psUid:'new' };
}

async function startRun(){
  if(_busy){ setStat('이미 실행 중입니다. (중복 클릭 무시)'); return; }   // ★#1 중복 실행 방지
  _busy=true;
  try{
    _stopStart=false;
    var siteVal=(q('#tmgStSite')&&q('#tmgStSite').value)||'';
    var sites=listSites();
    var site=sites.filter(function(s){return s.short===siteVal;})[0]||sites[0];
    if(!site){ setStat('대상 사이트가 없습니다(THE MANGO 제외).'); return; }
    // 설정값은 미리 읽어둔다(★#2 maxv 미선언 ReferenceError 방지)
    var dry=!!(q('#tmgStDry') && q('#tmgStDry').checked);
    var onlyUnmapped=!(q('#tmgStAll') && q('#tmgStAll').checked); // 기본: 미매핑만
    var maxv=parseInt((q('#tmgStMax') && q('#tmgStMax').value)||'0',10)||0;
    // 확인창은 버튼 클릭 제스처가 살아있는 '시작 시점'에 띄운다(비동기 뒤엔 브라우저가 confirm을 막을 수 있음)
    if(!_nativeConfirm('['+site.name+'] 카테고리 매핑을 시작합니다.\n· '+(dry?'[테스트: 저장 안 함]':'[실제 저장]')+'\n· '+(onlyUnmapped?'미매핑만 처리(기존 매핑 보존)':'전체 재매핑')+(maxv?('\n· 앞 '+maxv+'개만'):'')+'\n\n리프 탐색·상태확인(수십 초) 후 자동 진행됩니다. 시작할까요?')){ setStat('취소됨'); return; }
    setStat('['+site.name+'] 리프 카테고리 탐색 중...');
    var leaves;
    try{ leaves=await enumerateLeaves(site.short); }catch(e){ setStat('탐색 실패: '+e.message); return; }
    if(_stopStart){ setStat('정지했습니다.'); return; }
    if(!leaves.length){ setStat('리프 카테고리를 찾지 못했습니다.'); return; }
    // ★ 리프마다 매핑상태/ps_uid 개별 확인(병렬 배치). 미매핑=신규(new), 기존=그 리프 ps_uid.
    for(var bi=0; bi<leaves.length; bi+=8){
      if(_stopStart){ setStat('정지했습니다.'); return; }
      var batch=leaves.slice(bi,bi+8);
      var infos=await Promise.all(batch.map(function(lf){ return leafInfo(lf.id); }));
      infos.forEach(function(inf,j){ batch[j].psUid=inf.psUid; batch[j].mapped=inf.mapped; });
      setStat('기존 매핑 상태 확인 중... ('+Math.min(bi+8,leaves.length)+'/'+leaves.length+')');
    }
    var mappedCnt=leaves.filter(function(l){return l.mapped;}).length;
    var unmappedCnt=leaves.length-mappedCnt;
    var queue = onlyUnmapped ? leaves.filter(function(l){ return !l.mapped; }) : leaves;
    if(maxv && queue.length>maxv) queue=queue.slice(0,maxv);
    if(!queue.length){ setStat('처리할 리프가 없습니다'+(onlyUnmapped?(' (미매핑 0개 — 이미 전부 매핑됨).'):('.'))); return; }
    if(_stopStart){ setStat('정지했습니다.'); return; }
    setStat('시작 — 대상 '+queue.length+'개 '+(onlyUnmapped?'(미매핑만)':'(전체)')+' · 전체 '+leaves.length+'/기존 '+mappedCnt+'/미매핑 '+unmappedCnt);
    ss({running:true, dry:dry, idx:0, ok:0, fail:0, skip:0, max:0, site:site.name, onlyUnmapped:onlyUnmapped, queue:queue, log:[]});
    location.href=setUrl(queue[0]);
  } finally { _busy=false; }
}

// =========================================================================
// 실행 결과 내보내기(평가용): state.log(리프별 chosen)를 CSV + 이상리포트로 다운로드
//   ※ 서버 되읽기가 아니라, 매크로가 "리프별로 고른/저장한" 카테고리를 그대로 평가.
// =========================================================================
function stampNow(){ var d=new Date(), p=function(n){return String(n).padStart(2,'0');}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes()); }
var ELEVEN_OVERSEAS=/해외/;   // ★단계형: 11번가 국내여야 함 → '해외'는 이상
var BRAND_RE=/브랜드/;
// ★비-신발 오분류: 신발 리프에는 절대 안 나오는 어휘가 '리프(마지막 세그)'에 있으면 오분류(의류·양말·신발끈·잡화 등).
//   전체 경로가 아니라 리프로 판정해야 중간노드 '스포츠의류/운동화'·'운동화끈'의 '운동화'에 속지 않음.
var NONFOOT_LEAF=/스웨터|카디건|가디건|풀오버|니트|맨투맨|후드티|트레이닝복|져지|레깅스|바지|팬츠|치마|스커트|원피스|재킷|자켓|코트|점퍼|블라우스|터틀넥|브이넥|의류|양말|삭스|가방|백팩|파우치|신발끈|운동화끈|깔창|인솔|신발소품|신발용품|등산화소품|슈케어|구두약|키퍼|부츠컷|와이드핏|스키니|청바지|데님/;
var PATH_CLOTH=/의류|언더웨어|스포츠웨어/;
var GENERIC_LEAF=/^(기타|용품|패션\s*용품|잡화)$/;
function analyzeLog(log){
  var flags=[];
  (log||[]).forEach(function(f){
    var c=classify(f.name||'');
    MARKETS.forEach(function(m){
      var raw=(f.chosen&&f.chosen[MLABEL[m]])||'';
      var cat=String(raw).replace(/^\(유지\)/,'').trim();
      function add(type,detail){ flags.push({id:f.id,name:f.name,market:MLABEL[m],cat:cat||'(비어있음)',type:type,detail:detail||''}); }
      if(!cat){ add('미매핑'); return; }
      if(INVALID_MARK.test(cat)) add('사이트무효표시');
      if(famOfBase(c.base)==='SHOES'){   // ★신발 사이트: 리프가 명백한 비-신발이면 오분류로 표시
        var leafSeg=(cat.split('>').pop()||'').trim();
        if(NONFOOT_LEAF.test(leafSeg) || (PATH_CLOTH.test(cat) && GENERIC_LEAF.test(leafSeg))) add('비-신발오분류', leafSeg);
      }
      if(PET.test(cat)) add('규칙위반-반려동물');
      if(FORBIDDEN.test(cat)) add('규칙위반-금지어');
      if(m==='11ST'&&ELEVEN_FORBIDDEN.test(cat)) add('규칙위반-11번가디자이너/biz');
      if(m==='11ST'&&ELEVEN_OVERSEAS.test(cat)) add('규칙위반-11번가해외(국내여야함)');
      if((m==='AUC20'||m==='GMK20')&&BRAND_RE.test(cat)) add('규칙위반-브랜드');
      var hasW=/여성|여자|Women|Woman|레이디|Ladies/i.test(cat), hasM=/남성|남자|\bMen\b|\bMan\b/i.test(cat);
      if(c.gender==='W'&&hasM&&!hasW) add('성별불일치','여성→남성카테고리');
      if(c.gender==='M'&&hasW&&!hasM) add('성별불일치','남성→여성카테고리');
      var bf=famOfBase(c.base); if(bf){ var fams=famsOf(cat); if(fams.length&&fams.indexOf(bf)<0) add('유형검토(추정)', c.base+'('+bf+')→'+fams.join(',')); }
    });
  });
  return flags;
}
function csvq(s){ s=(s==null?'':String(s)); return '"'+s.replace(/"/g,'""')+'"'; }
function buildCSVlog(state){
  var cols=['id','카테고리경로','성별','유형(base)','상태'].concat(MARKETS.map(function(m){return MLABEL[m];}));
  var csv=cols.map(csvq).join(',')+'\n';
  (state.log||[]).forEach(function(f){
    var c=classify(f.name||'');
    var stat=f.saved?'저장됨':(state.dry?'테스트(미저장)':(f.err?('실패:'+f.err):'미저장'));
    var row=[f.id,f.name,({W:'여성',M:'남성',U:'공용'})[c.gender],c.base,stat]
      .concat(MARKETS.map(function(m){ return (f.chosen&&f.chosen[MLABEL[m]])||''; }));
    csv+=row.map(csvq).join(',')+'\n';
  });
  return '﻿'+csv;
}
function buildReportLog(state, flags){
  var now=stampNow();
  var byType={}; flags.forEach(function(x){ byType[x.type]=(byType[x.type]||0)+1; });
  var R='';
  R+='========================================================\n';
  R+=' 더망고 단계형 카테고리매핑 결과 · 이상 케이스 리포트\n';
  R+=' 사이트: '+(state.site||'-')+'  |  리프 '+((state.log||[]).length)+'개  |  '+(state.readback?'[실제 저장값 되읽기]':(state.dry?'[테스트 계산]':'[실제 저장]'))+'  |  생성 '+now+'\n';
  R+='========================================================\n\n[요약]\n';
  Object.keys(byType).sort(function(a,b){return byType[b]-byType[a];}).forEach(function(k){ R+='  '+k+': '+byType[k]+'건\n'; });
  R+= state.readback
    ? '\n※ 이 리포트는 서버에 실제 저장된 값을 리프별로 되읽어(admin_category_set.php · 리프 고유 ps_uid) 평가한 것입니다. [A] 사이트무효표시("카테고리를 변경해주세요")가 정확히 반영됩니다.\n'
    : '\n※ 이 리포트는 매크로가 리프별로 "고른" 카테고리를 평가한 것입니다(서버 되읽기 아님 — [A] 무효표시는 누락될 수 있음. 정확 평가는 "실제 저장값 되읽기" 버튼 사용).\n';
  R+='※ 단계형=국내 사업자 기준: 11번가 "해외"는 이상으로 표시.\n';
  function sect(title,type){ R+='\n─────────────────────────────────────\n'+title+'\n─────────────────────────────────────\n'; var arr=flags.filter(function(f){return f.type===type;}); if(!arr.length){R+='  (없음)\n';return;} arr.forEach(function(f){ R+='  - ['+f.id+'] '+f.name+'\n      '+f.market+': '+f.cat+'\n'; }); }
  sect('[A] 사이트 무효 표시','사이트무효표시');
  sect('[B] 반려동물','규칙위반-반려동물');
  sect('[C] 옥션/지마켓 브랜드','규칙위반-브랜드');
  sect('[D] 11번가 디자이너/biz','규칙위반-11번가디자이너/biz');
  sect('[D2] 11번가 해외(국내여야 함)','규칙위반-11번가해외(국내여야함)');
  sect('[E] 공통 금지어','규칙위반-금지어');
  sect('[F] 성별 불일치','성별불일치');
  sect('[G] 미매핑','미매핑');
  sect('[I] 비-신발 오분류(의류/양말/신발끈/키즈 등 · 리프 기준)','비-신발오분류');
  R+='\n─────────────────────────────────────\n[H] 유형 불일치(추정 — 검토 필요)\n─────────────────────────────────────\n';
  var soft=flags.filter(function(f){return f.type==='유형검토(추정)';});
  var pat={}; soft.forEach(function(f){ (pat[f.detail]=pat[f.detail]||[]).push(f); });
  Object.keys(pat).sort(function(a,b){return pat[b].length-pat[a].length;}).forEach(function(k){ R+='\n▶ '+k+' ('+pat[k].length+'건)\n'; pat[k].forEach(function(f){ R+='  - ['+f.id+'] '+f.name+'\n      '+f.market+': '+f.cat+'\n'; }); });
  return R;
}
function download(name, text){ var blob=new Blob([text],{type:'text/plain;charset=utf-8'}); var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); },1000); }
function exportRun(state){
  if(!state || !state.log || !state.log.length){ setStat('내보낼 결과가 없습니다(먼저 실행하세요).'); return; }
  var flags=analyzeLog(state.log);
  var stamp=stampNow();
  var tag=(state.site||'ABC').replace(/[^\w가-힣.]/g,'');
  var kind=state.readback?'실제저장값':'실행계산값';
  download('단계형매핑_'+kind+'_'+tag+'_'+stamp+'.csv', buildCSVlog(state));
  download('단계형매핑_'+kind+'_이상리포트_'+tag+'_'+stamp+'.txt', buildReportLog(state, flags));
  var invalid=flags.filter(function(f){return f.type==='사이트무효표시';}).length;
  var hard=flags.filter(function(f){return f.type!=='유형검토(추정)'&&f.type!=='미매핑';}).length;
  var soft=flags.filter(function(f){return f.type==='유형검토(추정)';}).length;
  setStat((state.readback?'[실제 저장값] ':'')+'결과 내보냄 — 리프 '+state.log.length+' · 무효표시 '+invalid+' · 확정위반 '+hard+' · 유형검토 '+soft+' (파일 2개)');
}

// =========================================================================
// ★ 실제 저장값 되읽기 평가 (정확) — 서버에 저장된 리프별 마켓 매핑을 다시 읽어 평가.
//   로그 기반 평가는 "매크로가 고른 값"이라 [A] 사이트무효표시("카테고리를 변경해주세요")를
//   놓친다(무효 판정은 저장 후 서버가 내림). 되읽기는 각 리프의 고유 ps_uid로
//   admin_category_set.php를 fetch해 마켓 select의 실제 선택값을 읽으므로 정확하다.
//   (set 페이지는 '리프 고유 ps_uid'를 넘겨야 그 리프 값을 반환. category_id만으론 세션값.)
// =========================================================================
async function scanLeafActual(leaf){
  var url=DIR()+'admin_category_set.php?category_id='+leaf.id+'&ps_uid='+(leaf.psUid||'new')+'&tm=';
  var html=await fetch(url,{credentials:'same-origin'}).then(function(r){return r.text();});
  var doc=new DOMParser().parseFromString(html,'text/html');
  var chosen={};
  MARKETS.forEach(function(m){
    var sel=doc.getElementById('openmarket_category_search_list_'+m);
    var txt=(sel && sel.options.length)?((sel.options[sel.selectedIndex]||sel.options[0]).text||'').trim():'';
    // "변경해주세요"(무효)는 그대로 보존해 analyzeLog가 [A]로 잡게 함.
    // 실제 카테고리 경로는 '>' 포함. 그 외(예: "- ...선택해주세요 -")는 미매핑으로 정규화.
    if(!/변경해\s*주세요/.test(txt) && txt.indexOf('>')<0) txt='';
    chosen[MLABEL[m]]=txt;
  });
  return chosen;
}
async function readbackExport(siteName){
  var sites=listSites();
  var site = siteName ? (sites.filter(function(s){return s.name===siteName;})[0]) : null;
  if(!site){ var sv=(q('#tmgStSite')&&q('#tmgStSite').value)||''; site=sites.filter(function(s){return s.short===sv;})[0]||sites[0]; }
  if(!site){ setStat('대상 사이트가 없습니다.'); return; }
  setStat('['+site.name+'] 실제 저장값 되읽기 — 리프 탐색...');
  var leaves;
  try{ leaves=await enumerateLeaves(site.short); }catch(e){ setStat('탐색 실패: '+e.message); return; }
  if(!leaves.length){ setStat('리프 카테고리를 찾지 못했습니다.'); return; }
  // 리프별 고유 ps_uid 확보(미매핑은 'new' → 되읽으면 전부 미매핑으로 표시됨)
  for(var bi=0; bi<leaves.length; bi+=8){
    var batch=leaves.slice(bi,bi+8);
    var infos=await Promise.all(batch.map(function(lf){ return leafInfo(lf.id); }));
    infos.forEach(function(inf,j){ batch[j].psUid=inf.psUid; batch[j].mapped=inf.mapped; });
    setStat('매핑상태 확인 중... ('+Math.min(bi+8,leaves.length)+'/'+leaves.length+')');
  }
  var log=[];
  for(var i=0;i<leaves.length;i++){
    setStat('실제 저장값 읽는 중 '+(i+1)+'/'+leaves.length+' — '+leaves[i].name);
    var chosen; try{ chosen=await scanLeafActual(leaves[i]); }catch(e){ chosen={}; }
    log.push({ id:leaves[i].id, name:leaves[i].name, kw:classify(leaves[i].name).keyword, chosen:chosen, saved:true });
    if(i%10===9) await sleep(80);
  }
  exportRun({ site:site.name, dry:false, readback:true, log:log });
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
   +'<div style="margin-bottom:4px"><label><input type="checkbox" id="tmgStAll"> 이미 매핑된 것도 다시 매핑(전체) <span style="color:#888">(기본=미매핑만)</span></label></div>'
   +'<div style="margin-bottom:4px">앞에서 <input id="tmgStMax" type="number" value="3" min="0" style="width:50px"> 개만 (0=전체)</div>'
   +'<button id="tmgStGo">리프 탐색 &amp; 시작</button> <button id="tmgStStop" style="color:#d9534f">정지</button>'
   +'<div style="margin-top:6px"><button id="tmgStReadback" style="font-weight:bold;color:#0a7">실제 저장값 평가 (되읽기 · 정확)</button></div>'
   +'<div style="margin-top:4px"><button id="tmgStExport">지난 실행 계산값 내보내기 (참고)</button></div>'
   +'<div id="tmgStStat" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">※ 리프마다 매핑상태를 확인해 <b>미매핑만</b> 신규 생성(ps_uid=new), 기존 매핑은 보존합니다. 11번가는 국내 카테고리.<br>※ <b>실제 저장값 평가</b>는 서버에 저장된 값을 리프별로 되읽어 평가(=<b>[A] "카테고리를 변경해주세요" 무효표시까지 정확히 검출</b>). 실제 저장 모드로 실행이 끝나면 이 되읽기 평가가 자동 실행됩니다(테스트 모드는 저장 전이라 계산값으로 내보냄).</div>';
  document.body.appendChild(p);
  q('#tmgStGo').onclick=startRun;
  q('#tmgStStop').onclick=function(){ _stopStart=true; var s=gs(); if(s){ s.running=false; ss(s); } setStat('정지했습니다.'); };
  q('#tmgStReadback').onclick=function(){ readbackExport(); };
  q('#tmgStExport').onclick=function(){ exportRun(gs()); };
  // 실행 완료 후 이 페이지로 돌아온 경우: 자동 내보내기(안정적인 페이지에서 다운로드)
  //  - 실제 저장 모드: 서버 되읽기 평가(정확) 자동 실행
  //  - 테스트 모드: 저장 전이라 되읽을 값이 없음 → 계산값(참고) 내보내기
  var st=gs();
  if(st && st.exportPending && st.log && st.log.length){
    st.exportPending=false; ss(st);
    if(st.dry){
      setStat('완료 — 계산값(참고) 내보내는 중...');
      setTimeout(function(){ exportRun(st); }, 800);
    } else {
      setStat('완료 — 실제 저장값 되읽기 평가 중...');
      setTimeout(function(){ readbackExport(st.site); }, 800);
    }
  }
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
