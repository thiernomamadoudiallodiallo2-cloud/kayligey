// Stockage privé des fichiers (Netlify Blobs). Jamais d'URL publique : tout passe par l'API authentifiée.
let driver=null;export const __setBlobDriver=d=>{driver=d;};
async function store(){
  if(driver)return driver;
  const {getStore}=await import('@netlify/blobs');const s=getStore('kayligey-documents');
  return {put:(k,buf)=>s.set(k,buf),get:async k=>{const a=await s.get(k,{type:'arrayBuffer'});return a?Buffer.from(a):null;}};
}
export const putBlob=async(k,buf)=>(await store()).put(k,buf);
export const getBlob=async k=>(await store()).get(k);
