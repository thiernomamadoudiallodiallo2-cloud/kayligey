// Adaptateur : exécute une requête SQL « texte + paramètres » avec le pilote Neon, quelle que soit sa version
// (0.10.x : sql(texte, params) ; 1.x : sql.query(texte, params)).
export const makeQ=sql=>(t,p=[])=>typeof sql.query==='function'?sql.query(t,p):sql(t,p);
