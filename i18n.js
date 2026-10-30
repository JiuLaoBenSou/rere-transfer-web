import i18next from './vendor/i18next/i18next.js?v=usage1';
import LanguageDetector from './vendor/i18next/detector.js?v=usage1';
import en from './locales-en.js?v=usage1';
import {supportedLanguages,loadCatalog,localeCatalogs} from './locales.js?v=usage1';
export function resolveLanguage({query,saved,languages=[]}={}){
 for(const value of[query,saved,...languages]){if(/^zh-(TW|HK|MO|Hant)(?:-|$)/i.test(value||''))return'zh-TW';if(/^zh(?:-|$)/i.test(value||''))return'zh-CN';const short=String(value||'').toLowerCase().split('-')[0];if(supportedLanguages.some(([code])=>code===short))return short;}return'zh-CN';
}
const browser=typeof window!=='undefined'&&typeof document!=='undefined';
let language='zh-CN';
if(browser){const detector=new LanguageDetector();detector.init({}, {order:['querystring','localStorage','navigator'],lookupQuerystring:'lang',lookupLocalStorage:'rere-language'});language=resolveLanguage({languages:[].concat(detector.detect()||[])});}
await Promise.all((browser?[language]:supportedLanguages.map(([code])=>code)).map(loadCatalog));
i18next.init({lng:language,fallbackLng:'zh-CN',supportedLngs:supportedLanguages.map(([code])=>code),initAsync:false,keySeparator:false,nsSeparator:false,resources:Object.fromEntries(Object.entries(localeCatalogs).map(([code,catalog])=>[code,{translation:catalog}])),interpolation:{escapeValue:false},showSupportNotice:false});
export const getLanguage=()=>language;
export const translate=(key,values={},lng=language)=>typeof key!=='string'?'':i18next.t(key,{...values,lng});
export const t=translate;
export function initPage(){
 if(!browser)return;
 document.documentElement.lang=language;
 if(language!=='zh-CN')for(const brand of document.querySelectorAll('.brand,.site-header>a:first-child')){for(const img of brand.querySelectorAll('img')){img.src='./rere-symbol.svg';img.width=40;img.height=40;img.style.width='40px';}const word=document.createElement('span');word.className='brand-wordmark';word.textContent=language==='zh-TW'?'熱熱傳':'WarmDrop';brand.append(word);}
 const walker=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
 for(const node of nodes){if(/^(SCRIPT|STYLE|NOSCRIPT)$/.test(node.parentElement?.tagName))continue;const raw=node.textContent,key=raw.trim();if(Object.hasOwn(en,key))node.textContent=raw.replace(key,t(key));}
 for(const node of document.querySelectorAll('[placeholder],[aria-label],[alt],meta[name="description"]'))for(const attr of['placeholder','aria-label','alt','content']){const text=node.getAttribute(attr);if(text&&Object.hasOwn(en,text))node.setAttribute(attr,t(text));}
 if(language!=='zh-CN')for(const img of document.querySelectorAll('figure img')){const url=new URL(img.src,location.href);if(/\/help\/(pair|send|receive)\.png$/.test(url.pathname))img.src=img.src.replace('.png','-'+language+'.png');}
 for(const a of document.querySelectorAll('a[href]')){const url=new URL(a.href,location.href);if(url.origin===location.origin&&(!/\.[a-z]+$/i.test(url.pathname)||/\.html$/.test(url.pathname))){url.searchParams.set('lang',language);a.href=url.href;}}
 const header=document.querySelector('.topbar,.site-header');if(header&&!document.querySelector('#language-select')){
  const label=document.createElement('label');label.className='language-control';label.textContent='Language ';
  const select=document.createElement('select');select.id='language-select';select.setAttribute('aria-label','Language');
  for(const[value,text]of supportedLanguages){const option=new Option(text,value);select.append(option);}select.value=language;
  select.title=t('切换语言将重新加载页面。');select.addEventListener('change',()=>{if(window.canChangeLanguage&&!window.canChangeLanguage()){select.value=language;return;}try{localStorage.setItem('rere-language',select.value);}catch{}const url=new URL(location.href);url.searchParams.set('lang',select.value);location.assign(url.href);});label.append(select);const actions=document.createElement('div');actions.className='header-actions';const help=header.querySelector('.site-help,.back');if(help)actions.append(help);actions.append(label);header.append(actions);
 }
}
