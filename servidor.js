const http=require('http');
const https=require('https');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {URL}=require('url');
const {DatabaseSync}=require('node:sqlite');

function loadEnv(){
  const f=path.join(__dirname,'.env');
  if(!fs.existsSync(f)) return;
  for(const raw of fs.readFileSync(f,'utf8').split(/\r?\n/)){
    const s=raw.trim(); if(!s||s.startsWith('#')) continue;
    const i=s.indexOf('='); if(i<1) continue;
    let v=s.slice(i+1).trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
    if(process.env[s.slice(0,i).trim()]===undefined) process.env[s.slice(0,i).trim()]=v;
  }
}
loadEnv();
const PORT=Number(process.env.PORT||3000);
const PUBLIC_BASE_URL=String(process.env.PUBLIC_BASE_URL||'').replace(/\/$/,'');
const MP_TOKEN=process.env.MERCADO_PAGO_ACCESS_TOKEN||'';
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'';
const ROOT=__dirname, PUBLIC=path.join(ROOT,'public'), DATA=path.join(ROOT,'data'), STORAGE=path.join(ROOT,'storage');
for(const d of [DATA,path.join(STORAGE,'originales'),path.join(STORAGE,'previews')]) fs.mkdirSync(d,{recursive:true});
const db=new DatabaseSync(path.join(DATA,'kiosco.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS eventos(id TEXT PRIMARY KEY,nombre TEXT NOT NULL,fecha TEXT NOT NULL,lugar TEXT,descripcion TEXT,precio REAL NOT NULL,slug TEXT NOT NULL UNIQUE,publicado INTEGER NOT NULL DEFAULT 0,creado TEXT NOT NULL,publicado_en TEXT);
CREATE TABLE IF NOT EXISTS fotos(id TEXT PRIMARY KEY,evento_id TEXT NOT NULL,nombre TEXT NOT NULL,archivo_original TEXT NOT NULL,archivo_preview TEXT,creado TEXT NOT NULL,FOREIGN KEY(evento_id) REFERENCES eventos(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_fotos_evento ON fotos(evento_id);
CREATE TABLE IF NOT EXISTS pedidos(id TEXT PRIMARY KEY,evento_id TEXT NOT NULL,email TEXT NOT NULL,total REAL NOT NULL,estado TEXT NOT NULL,mp_payment_id TEXT,creado TEXT NOT NULL,pagado_en TEXT,FOREIGN KEY(evento_id) REFERENCES eventos(id));
CREATE TABLE IF NOT EXISTS pedido_fotos(pedido_id TEXT NOT NULL,foto_id TEXT NOT NULL,precio REAL NOT NULL,PRIMARY KEY(pedido_id,foto_id),FOREIGN KEY(pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,FOREIGN KEY(foto_id) REFERENCES fotos(id));`);

const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(obj));};
const html=(res,status,s)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(s);};
function body(req,max=120*1024*1024){return new Promise((resolve,reject)=>{const a=[];let n=0;req.on('data',c=>{n+=c.length;if(n>max){reject(new Error('Archivo demasiado grande'));req.destroy();return}a.push(c)});req.on('end',()=>resolve(Buffer.concat(a)));req.on('error',reject)});}
function safe(s){return String(s||'').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,180)}
function mime(ext){return ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif'})[ext]||'application/octet-stream'}
function auth(req,res){
  if(!ADMIN_PASSWORD) return true;
  const h=req.headers.authorization||'';
  if(!h.startsWith('Basic ')){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kiosco Digital"'});res.end('Autenticacion requerida');return false}
  let decoded='';try{decoded=Buffer.from(h.slice(6),'base64').toString()}catch{}
  const pass=decoded.slice(decoded.indexOf(':')+1);
  if(pass!==ADMIN_PASSWORD){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kiosco Digital"'});res.end('Clave incorrecta');return false}
  return true;
}
function publicEvent(e){const fotos=db.prepare('SELECT COUNT(*) AS n FROM fotos WHERE evento_id=?').get(e.id);return {id:e.id,nombre:e.nombre,fecha:e.fecha,lugar:e.lugar,descripcion:e.descripcion,precio:e.precio,slug:e.slug,publicado:Boolean(e.publicado),fotos:Number(fotos.n)}}
function getEvent(id){return db.prepare('SELECT * FROM eventos WHERE id=?').get(id)}
function mpRequest(method,apiPath,payload){return new Promise((resolve,reject)=>{const b=payload?JSON.stringify(payload):null;const r=https.request({hostname:'api.mercadopago.com',path:apiPath,method,headers:{Authorization:'Bearer '+MP_TOKEN,'Content-Type':'application/json',...(b?{'Content-Length':Buffer.byteLength(b)}:{})}},res=>{const a=[];res.on('data',c=>a.push(c));res.on('end',()=>{const t=Buffer.concat(a).toString();let d;try{d=JSON.parse(t)}catch{d={message:t}};if(res.statusCode>=200&&res.statusCode<300)resolve(d);else reject(new Error(`Mercado Pago HTTP ${res.statusCode}: ${d.message||d.error||t}`))})});r.on('error',reject);if(b)r.end(b);else r.end()})}
function orderInfo(id){
  const o=db.prepare('SELECT * FROM pedidos WHERE id=?').get(id); if(!o)return null;
  const fotos=db.prepare('SELECT f.id,f.nombre,f.archivo_original,pf.precio FROM pedido_fotos pf JOIN fotos f ON f.id=pf.foto_id WHERE pf.pedido_id=?').all(id);
  return {...o,fotos};
}
function downloadPage(id){return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Descarga · Julio Ojeda</title><style>body{font-family:Arial;background:#f4f7f9;color:#173b5d;text-align:center;padding:30px}.box{max-width:620px;margin:auto;background:#fff;border-radius:18px;padding:25px;box-shadow:0 5px 24px #173b5d18}a{display:block;background:#1677a8;color:#fff;text-decoration:none;padding:13px;border-radius:10px;margin:10px}</style><div class="box"><h1>📸 Tus fotografías</h1><div id="estado">Verificando el pago...</div><div id="links"></div></div><script>const id=${JSON.stringify(id)};async function cargar(){try{const r=await fetch('/api/pedidos/'+encodeURIComponent(id));const d=await r.json();if(!r.ok)throw Error(d.error||'Error');if(d.pagado){document.getElementById('estado').innerHTML='<b>Pago confirmado.</b><p>Ya podés descargar tus originales.</p>';document.getElementById('links').innerHTML=d.fotos.map((f,i)=>'<a href="/descargar?pedido='+encodeURIComponent(id)+'&foto='+encodeURIComponent(f.id)+'">⬇ Descargar '+(i+1)+' · '+f.nombre+'</a>').join('');return}document.getElementById('estado').innerHTML='<b>Pago pendiente.</b><p>Esperando confirmación de Mercado Pago...</p>';setTimeout(cargar,3000)}catch(e){document.getElementById('estado').textContent=e.message}}cargar()</script>`}

async function handle(req,res){
  const u=new URL(req.url,'http://localhost:'+PORT), p=u.pathname;
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-File-Name,Authorization'});return res.end()}
  try{
    if(req.method==='GET'&&p==='/api/estado')return json(res,200,{ok:true,almacenamiento:'DISCO_LOCAL',baseDatos:'SQLITE',mercadoPago:Boolean(MP_TOKEN),publicBaseUrl:Boolean(PUBLIC_BASE_URL),adminProtegido:Boolean(ADMIN_PASSWORD)});
    if(req.method==='GET'&&p==='/api/eventos')return json(res,200,db.prepare('SELECT * FROM eventos WHERE publicado=1 ORDER BY fecha DESC, creado DESC').all().map(publicEvent));
    if(req.method==='GET'&&p.startsWith('/api/eventos/')){
      const id=decodeURIComponent(p.slice('/api/eventos/'.length)),e=getEvent(id);if(!e||!e.publicado)return json(res,404,{error:'Evento no encontrado'});
      const fotos=db.prepare('SELECT id,nombre,archivo_preview FROM fotos WHERE evento_id=? ORDER BY rowid').all(id).map(f=>({...f,url:'/previews/'+encodeURIComponent(e.slug)+'/'+encodeURIComponent(f.archivo_preview||f.archivo_original)}));
      return json(res,200,{ok:true,evento:publicEvent(e),fotos});
    }
    if(req.method==='GET'&&p.startsWith('/previews/')){
      const parts=p.split('/').slice(2).map(decodeURIComponent);if(parts.length!==2)return res.writeHead(404).end();
      const f=parts[1],full=path.join(STORAGE,'previews',parts[0],f);if(!full.startsWith(path.join(STORAGE,'previews')))return res.writeHead(400).end();
      return fs.createReadStream(full).on('error',()=>res.writeHead(404).end()).once('open',()=>{res.writeHead(200,{'Content-Type':mime(path.extname(full).toLowerCase()),'Cache-Control':'public,max-age=31536000'});}).pipe(res);
    }
    if(req.method==='GET'&&p==='/admin.html' || req.method==='GET'&&p==='/admin') {if(!auth(req,res))return;return serveStatic(res,'admin.html')}
    if(p.startsWith('/api/admin/')){if(!auth(req,res))return;
      if(req.method==='GET'&&p==='/api/admin/eventos')return json(res,200,db.prepare('SELECT * FROM eventos ORDER BY creado DESC').all().map(publicEvent));
      if(req.method==='POST'&&p==='/api/admin/eventos'){
        const d=JSON.parse((await body(req,2*1024*1024)).toString()||'{}');if(!d.nombre||!d.fecha||!Number(d.precio))return json(res,400,{error:'Nombre, fecha y precio son obligatorios'});
        const id=crypto.randomUUID(),slug=safe((d.nombre+'-'+id.slice(0,8)).toLowerCase()),now=new Date().toISOString();db.prepare('INSERT INTO eventos VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,String(d.nombre).trim(),String(d.fecha),String(d.lugar||'').trim(),String(d.descripcion||'').trim(),Number(d.precio),slug,0,now,null);return json(res,201,{ok:true,evento:publicEvent(getEvent(id))});
      }
      if(req.method==='POST'&&p==='/api/admin/subir'){
        const eid=u.searchParams.get('eventoId'),e=getEvent(eid);if(!e)return json(res,404,{error:'Evento no encontrado'});
        const ct=String(req.headers['content-type']||'').split(';')[0].toLowerCase();if(!/^image\/(jpeg|png|webp|gif)$/.test(ct))return json(res,400,{error:'Formato de imagen no permitido'});
        const original=safe(decodeURIComponent(String(req.headers['x-file-name']||'foto.jpg'))),ext=path.extname(original).toLowerCase()||'.jpg',stem=safe(path.basename(original,path.extname(original))),archivo=Date.now()+'-'+crypto.randomBytes(3).toString('hex')+'-'+stem+ext,b=await body(req);
        const dir=path.join(STORAGE,'originales',e.slug);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,archivo),b);const id=crypto.randomUUID();db.prepare('INSERT INTO fotos VALUES(?,?,?,?,?,?)').run(id,e.id,original,archivo,null,new Date().toISOString());return json(res,201,{ok:true,foto:{id,nombre:original}});
      }
      if(req.method==='POST'&&p==='/api/admin/subir-preview'){
        const id=u.searchParams.get('fotoId'),f=db.prepare('SELECT f.*,e.slug FROM fotos f JOIN eventos e ON e.id=f.evento_id WHERE f.id=?').get(id);if(!f)return json(res,404,{error:'Fotografía no encontrada'});const ct=String(req.headers['content-type']||'').split(';')[0].toLowerCase();if(ct!=='image/jpeg')return json(res,400,{error:'La miniatura debe ser JPEG'});const b=await body(req,20*1024*1024),base=path.basename(f.archivo_original,path.extname(f.archivo_original)),archivo='preview-'+base+'.jpg',dir=path.join(STORAGE,'previews',f.slug);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,archivo),b);db.prepare('UPDATE fotos SET archivo_preview=? WHERE id=?').run(archivo,id);return json(res,201,{ok:true,previewArchivo:archivo});
      }
      if(req.method==='POST'&&p==='/api/admin/publicar' || req.method==='POST'&&p==='/api/admin/despublicar'){
        const d=JSON.parse((await body(req)).toString()||'{}'),e=getEvent(d.eventoId);if(!e)return json(res,404,{error:'Evento no encontrado'});if(p.endsWith('/publicar')&&Number(publicEvent(e).fotos)<1)return json(res,400,{error:'No se puede publicar un evento sin fotografías'});const pub=p.endsWith('/publicar')?1:0;db.prepare('UPDATE eventos SET publicado=?,publicado_en=? WHERE id=?').run(pub,pub?new Date().toISOString():null,e.id);return json(res,200,{ok:true,evento:publicEvent(getEvent(e.id))});
      }
      if(req.method==='POST'&&p==='/api/admin/eliminar'){
        const d=JSON.parse((await body(req)).toString()||'{}'),e=getEvent(d.eventoId);if(!e)return json(res,404,{error:'Evento no encontrado'});db.prepare('DELETE FROM pedido_fotos WHERE pedido_id IN (SELECT id FROM pedidos WHERE evento_id=?)').run(e.id);db.prepare('DELETE FROM pedidos WHERE evento_id=?').run(e.id);const fotos=db.prepare('SELECT archivo_original,archivo_preview FROM fotos WHERE evento_id=?').all(e.id);for(const f of fotos){for(const root of ['originales','previews']){const n=root==='originales'?f.archivo_original:f.archivo_preview;if(n)try{fs.unlinkSync(path.join(STORAGE,root,e.slug,n))}catch{}}}db.prepare('DELETE FROM fotos WHERE evento_id=?').run(e.id);db.prepare('DELETE FROM eventos WHERE id=?').run(e.id);return json(res,200,{ok:true});
      }
    }
    if(req.method==='POST'&&p==='/api/pedidos'){
      const d=JSON.parse((await body(req,2*1024*1024)).toString()||'{}'),e=getEvent(d.eventoId);if(!e||!e.publicado)return json(res,404,{error:'Evento no encontrado'});const email=String(d.email||'').trim();if(!/^\S+@\S+\.\S+$/.test(email))return json(res,400,{error:'Ingresá un email válido para recibir la descarga'});const ids=Array.isArray(d.fotoIds)?[...new Set(d.fotoIds.map(String))]:[];if(!ids.length)return json(res,400,{error:'No hay fotografías seleccionadas'});const qs=ids.map(()=>'?').join(',');const fotos=db.prepare(`SELECT id,nombre FROM fotos WHERE evento_id=? AND id IN (${qs})`).all(e.id,...ids);if(fotos.length!==ids.length)return json(res,400,{error:'Una o más fotografías no pertenecen al evento'});const id=crypto.randomUUID(),total=Number((fotos.length*Number(e.precio)).toFixed(2));db.prepare('INSERT INTO pedidos VALUES(?,?,?,?,?,?,?,?)').run(id,e.id,email,total,'PENDIENTE',null,new Date().toISOString(),null);const ins=db.prepare('INSERT INTO pedido_fotos VALUES(?,?,?)');for(const f of fotos)ins.run(id,f.id,Number(e.precio));
      if(!MP_TOKEN)return json(res,200,{ok:true,id,estado:'PENDIENTE',mercadoPagoConfigurado:false});
      const pref={items:[{title:`Fotografías · ${e.nombre}`.slice(0,120),quantity:1,currency_id:'ARS',unit_price:total}],external_reference:id,payer:{email}};if(PUBLIC_BASE_URL){pref.notification_url=PUBLIC_BASE_URL+'/webhooks/mercadopago';pref.back_urls={success:PUBLIC_BASE_URL+'/pago-exitoso?pedido='+encodeURIComponent(id),failure:PUBLIC_BASE_URL+'/pago-fallido?pedido='+encodeURIComponent(id),pending:PUBLIC_BASE_URL+'/pago-pendiente?pedido='+encodeURIComponent(id)};pref.auto_return='approved';}const mp=await mpRequest('POST','/checkout/preferences',pref);db.prepare('UPDATE pedidos SET mp_payment_id=? WHERE id=?').run(String(mp.id||''),id);return json(res,200,{ok:true,id,init_point:mp.init_point,sandbox_init_point:mp.sandbox_init_point,total});
    }
    if(req.method==='GET'&&p.startsWith('/api/pedidos/')){const id=decodeURIComponent(p.slice('/api/pedidos/'.length)),o=orderInfo(id);if(!o)return json(res,404,{error:'Pedido no encontrado'});return json(res,200,{ok:true,id:o.id,estado:o.estado,pagado:o.estado==='APROBADO',fotos:o.fotos.map(f=>({id:f.id,nombre:f.nombre}))});}
    if(req.method==='POST'&&p==='/webhooks/mercadopago'){
      let d={};try{d=JSON.parse((await body(req,2*1024*1024)).toString()||'{}')}catch{};const paymentId=d?.data?.id||u.searchParams.get('data.id')||u.searchParams.get('id');if(paymentId&&MP_TOKEN){try{const pay=await mpRequest('GET','/v1/payments/'+encodeURIComponent(paymentId));const id=String(pay.external_reference||'');const o=db.prepare('SELECT * FROM pedidos WHERE id=?').get(id);if(o){db.prepare('UPDATE pedidos SET estado=?,mp_payment_id=?,pagado_en=? WHERE id=?').run(pay.status==='approved'?'APROBADO':String(pay.status||'PENDIENTE').toUpperCase(),String(paymentId),pay.status==='approved'?new Date().toISOString():null,id)}}catch(e){console.error('Webhook MP:',e.message)}}return res.writeHead(200).end('OK');
    }
    if(req.method==='GET'&&p==='/pago-exitoso')return html(res,200,downloadPage(u.searchParams.get('pedido')||''));
    if(req.method==='GET'&&p==='/pago-pendiente')return html(res,200,downloadPage(u.searchParams.get('pedido')||''));
    if(req.method==='GET'&&p==='/pago-fallido')return html(res,200,'<!doctype html><meta charset="utf-8"><body style="font-family:Arial;text-align:center;padding:40px"><h1>El pago no se completó</h1><p>Podés volver al álbum e intentarlo nuevamente.</p><a href="/">Volver</a></body>');
    if(req.method==='GET'&&p==='/descargar'){
      const id=u.searchParams.get('pedido'),fid=u.searchParams.get('foto'),o=orderInfo(id);if(!o||o.estado!=='APROBADO')return res.writeHead(403).end('Descarga no autorizada');const f=o.fotos.find(x=>x.id===fid);if(!f)return res.writeHead(404).end('Fotografía no encontrada');const e=getEvent(o.evento_id),full=path.join(STORAGE,'originales',e.slug,f.archivo_original);if(!full.startsWith(path.join(STORAGE,'originales')))return res.writeHead(400).end();fs.stat(full,(err,st)=>{if(err)return res.writeHead(404).end('Archivo no encontrado');res.writeHead(200,{'Content-Type':mime(path.extname(full).toLowerCase()),'Content-Length':st.size,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.nombre)}`});fs.createReadStream(full).pipe(res)});return;
    }
    return serveStatic(res,p==='/'?'index.html':decodeURIComponent(p.slice(1)));
  }catch(e){console.error(e);return json(res,500,{error:e.message||'Error interno del servidor'});}
}
function serveStatic(res,file){if(file.includes('..'))return res.writeHead(400).end('Ruta inválida');const full=path.join(PUBLIC,file);if(!full.startsWith(PUBLIC))return res.writeHead(400).end();fs.readFile(full,(err,data)=>{if(err)return res.writeHead(404).end('Archivo no encontrado');res.writeHead(200,{'Content-Type':mime(path.extname(full).toLowerCase())});res.end(data)});}
http.createServer(handle).listen(PORT,()=>{console.log(`Kiosco Digital listo en http://localhost:${PORT}`);console.log(`Almacenamiento: DISCO LOCAL | Base de datos: SQLITE | Mercado Pago: ${MP_TOKEN?'CONFIGURADO':'PENDIENTE'}`);});
