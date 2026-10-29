import en from './locales-en.js?v=warmdrop1';
export const supportedLanguages=[['zh-CN','简体中文'],['zh-TW','繁體中文'],['en','English'],['ja','日本語'],['ko','한국어'],['es','Español'],['fr','Français'],['de','Deutsch'],['pt','Português']];
export const localeCatalogs={en};
export async function loadCatalog(language){
 if(language==='zh-CN')return{};
 if(!supportedLanguages.some(([code])=>code===language))throw new Error('Unsupported language');
 if(!localeCatalogs[language])localeCatalogs[language]=(await import('./locales/'+language+'.js?v=warmdrop1')).default;
 return localeCatalogs[language];
}
