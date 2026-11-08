// A small local web app for the agent benchmark: realistic, fiddly pages (multi-step forms with
// validation, a shop with filters and checkout, a paged table with a modal, a form inside a
// cross-origin iframe built with shadow DOM, a task across two tabs). Every submission is checked
// on the server, so a run is scored by what actually happened, not by what the agent says.
// Synthetic data only.
import http from 'node:http';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#f6f7f8;color:#16181d}
header{background:#16181d;color:#fff;padding:12px 24px;display:flex;gap:18px;align-items:center}header a{color:#cfd3da;text-decoration:none}
main{max-width:980px;margin:24px auto;padding:0 20px}.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:20px;margin-bottom:16px}
label{display:block;margin:10px 0 4px;font-weight:600;font-size:13px}input,select,textarea{font:inherit;padding:8px 10px;border:1px solid #cdd2d8;border-radius:8px;width:100%;box-sizing:border-box}
input[type=checkbox],input[type=radio]{width:auto}.row{display:flex;gap:12px}.row>*{flex:1}
button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#2f5bea;color:#fff;cursor:pointer}button.ghost{background:#eef0f3;color:#16181d}
.err{color:#c62828;font-size:13px;margin-top:6px}.ok{background:#e8f5e9;border-color:#a5d6a7}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.prod{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px}.muted{color:#6b7280;font-size:13px}table{width:100%;border-collapse:collapse;background:#fff}
td,th{padding:8px;border-bottom:1px solid #eceff2;text-align:left}.switch{display:inline-block;width:40px;height:22px;border-radius:11px;background:#cdd2d8;position:relative;cursor:pointer;vertical-align:middle}
.switch[aria-checked=true]{background:#2f5bea}.switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}.switch[aria-checked=true]::after{left:21px}
dialog{border:0;border-radius:12px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.25)}.swatch{display:inline-block;width:26px;height:26px;border-radius:50%;border:2px solid transparent;cursor:pointer;margin-right:6px}.swatch.on{border-color:#16181d}
</style></head><body><header><b>Bench</b><a href="/signup">Sign up</a><a href="/shop">Shop</a><a href="/flights">Flights</a><a href="/support">Support</a><a href="/docs">Docs</a></header><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;

// ---------------------------------------------------------------------------- data
const COUNTRIES = ['Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil', 'Canada', 'Chile', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Iceland', 'India', 'Ireland', 'Italy', 'Japan', 'Kenya', 'Mexico', 'Netherlands', 'New Zealand', 'Norway', 'Poland', 'Portugal', 'Spain', 'Sweden', 'Switzerland', 'United Kingdom', 'United States'];
const PRODUCTS = [
  ['Trail Runner 2', 'Shoes', 89], ['Road Racer', 'Shoes', 119], ['City Walker', 'Shoes', 74], ['Peak Hiker', 'Shoes', 139], ['Trail Runner', 'Shoes', 69],
  ['Steel Bottle 750', 'Bottles', 24], ['Glass Bottle 500', 'Bottles', 19], ['Squeeze Bottle', 'Bottles', 9], ['Insulated Bottle 1L', 'Bottles', 32], ['Kids Bottle', 'Bottles', 12],
  ['Rain Jacket', 'Clothing', 129], ['Running Tee', 'Clothing', 29], ['Merino Socks', 'Clothing', 16], ['Wind Vest', 'Clothing', 59], ['Thermal Tights', 'Clothing', 45],
  ['Head Torch', 'Gear', 39], ['Trekking Poles', 'Gear', 79], ['Day Pack 20L', 'Gear', 89], ['First Aid Kit', 'Gear', 27], ['Map Case', 'Gear', 14],
].map(([name, cat, price], i) => ({ id: `p${i + 1}`, name, cat, price }));
const COUPONS = { SPRING10: 0.1, WELCOME5: 0.05 };
const SHIPPING = { standard: 0, express: 12 };
function flights() {
  const cities = ['Berlin', 'Paris', 'Madrid', 'Rome'];
  const out = [];
  let n = 0;
  for (const to of cities)
    for (let k = 0; k < 8; k++) {
      n++;
      const stops = (n * 7) % 3 === 0 ? 0 : (n % 2) + (to === 'Berlin' && k % 3 === 0 ? 0 : 1) - 1;
      out.push({ no: `BN${100 + n}`, from: 'Lisbon', to, dep: `${String(6 + ((n * 5) % 15)).padStart(2, '0')}:${n % 2 ? '05' : '40'}`, stops: Math.max(0, stops), price: 60 + ((n * 37) % 190), bag: `${[7, 10, 23][n % 3]} kg` });
    }
  // Berlin: the cheapest flight has a stop, and the cheapest direct one isn't on the first page by departure time.
  const berlin = [
    [1, 71, '05:30'], [0, 134, '06:10'], [0, 171, '07:05'], [1, 88, '08:40'],
    [0, 208, '09:15'], [0, 92, '18:40'], [1, 64, '20:05'], [0, 129, '21:30'],
  ];
  out.filter((f) => f.to === 'Berlin').forEach((f, i) => Object.assign(f, { stops: berlin[i][0], price: berlin[i][1], dep: berlin[i][2] }));
  return out;
}
const FLIGHTS = flights();

// ---------------------------------------------------------------------------- pages
function signup() {
  const opts = COUNTRIES.map((c) => `<option>${c}</option>`).join('');
  return page('Create your account', `
<div class="card" id="s1"><h2>Create your account <span class="muted">Step 1 of 3</span></h2>
<label for="name">Full name</label><input id="name" autocomplete="off">
<label for="email">Email</label><input id="email" type="email" autocomplete="off">
<div class="row"><div><label for="pw">Password</label><input id="pw" type="password" autocomplete="new-password"></div><div><label for="pw2">Confirm password</label><input id="pw2" type="password" autocomplete="new-password"></div></div>
<div class="err" id="e1" role="alert"></div><p><button id="next1">Continue</button></p></div>
<div class="card" id="s2" hidden><h2>Your preferences <span class="muted">Step 2 of 3</span></h2>
<fieldset style="border:0;padding:0"><legend style="font-weight:600;font-size:13px">Plan</legend>
<label style="display:inline;font-weight:400"><input type="radio" name="plan" value="Free" checked> Free</label>
<label style="display:inline;font-weight:400;margin-left:12px"><input type="radio" name="plan" value="Pro"> Pro</label>
<label style="display:inline;font-weight:400;margin-left:12px"><input type="radio" name="plan" value="Team"> Team</label></fieldset>
<label for="country">Country</label><select id="country"><option value="">Choose…</option>${opts}</select>
<label for="birth">Date of birth</label><input id="birth" type="date">
<div style="margin-top:10px;font-weight:600;font-size:13px">Interests</div>
${['Math', 'Music', 'Sport', 'Travel', 'Cooking'].map((i) => `<label style="display:inline;font-weight:400;margin-right:12px"><input type="checkbox" name="interest" value="${i}"> ${i}</label>`).join('')}
<p><span class="switch" role="switch" aria-checked="true" aria-label="Send me the newsletter" tabindex="0" id="news"></span> <span>Send me the newsletter</span></p>
<div class="err" id="e2" role="alert"></div><p><button class="ghost" id="back2">Back</button> <button id="next2">Continue</button></p></div>
<div class="card" id="s3" hidden><h2>Review <span class="muted">Step 3 of 3</span></h2><div id="review"></div>
<p><label style="display:inline;font-weight:400"><input type="checkbox" id="terms"> I agree to the terms</label></p>
<div class="err" id="e3" role="alert"></div><p><button class="ghost" id="back3">Back</button> <button id="create">Create account</button></p></div>
<div class="card ok" id="done" hidden></div>`, `
const $=(id)=>document.getElementById(id);const show=(n)=>['s1','s2','s3'].forEach((s,i)=>$(s).hidden=i!==n);
$('news').onclick=()=>$('news').setAttribute('aria-checked',$('news').getAttribute('aria-checked')==='true'?'false':'true');
$('news').onkeydown=(e)=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();$('news').click()}};
$('next1').onclick=()=>{const e=$('e1');if(!$('name').value.trim())return e.textContent='Enter your full name.';if(!/^[^@ ]+@[^@ ]+\\.[^@ ]+$/.test($('email').value))return e.textContent='Enter a valid email address.';
if($('pw').value.length<10)return e.textContent='Password needs at least 10 characters.';if($('pw').value!==$('pw2').value)return e.textContent='Passwords don’t match.';e.textContent='';show(1)};
$('back2').onclick=()=>show(0);$('back3').onclick=()=>show(1);
const data=()=>({name:$('name').value.trim(),email:$('email').value.trim(),plan:document.querySelector('input[name=plan]:checked').value,country:$('country').value,birth:$('birth').value,interests:[...document.querySelectorAll('input[name=interest]:checked')].map(x=>x.value),newsletter:$('news').getAttribute('aria-checked')==='true'});
$('next2').onclick=()=>{const d=data();if(!d.country)return $('e2').textContent='Choose your country.';if(!d.birth)return $('e2').textContent='Enter your date of birth.';$('e2').textContent='';
$('review').innerHTML='<p>'+[d.name,d.email,d.plan+' plan',d.country,'Born '+d.birth,'Interests: '+(d.interests.join(', ')||'none'),'Newsletter: '+(d.newsletter?'yes':'no')].map(x=>x.replace(/</g,'&lt;')).join('<br>')+'</p>';show(2)};
$('create').onclick=async()=>{if(!$('terms').checked)return $('e3').textContent='Please agree to the terms.';const r=await fetch('/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data())});const j=await r.json();
['s1','s2','s3'].forEach(s=>$(s).hidden=true);$('done').hidden=false;$('done').innerHTML='<h2>Welcome, '+j.name.replace(/</g,'&lt;')+'!</h2><p>Your confirmation code is <b id="code">'+j.code+'</b></p>'};`);
}

function shop() {
  return page('Bench Outdoor Shop', `
<div class="card"><div class="row"><div><label for="q">Search</label><input id="q" placeholder="Search products"></div>
<div><label for="cat">Category</label><select id="cat"><option value="">All</option><option>Shoes</option><option>Bottles</option><option>Clothing</option><option>Gear</option></select></div>
<div><label for="sort">Sort by</label><select id="sort"><option value="featured">Featured</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select></div></div></div>
<div class="grid" id="grid"></div>
<dialog id="pd"><h3 id="pdn"></h3><p id="pdp"></p><div id="opts"></div><label for="qty">Quantity</label><div class="row" style="align-items:center"><button class="ghost" id="minus" aria-label="Decrease quantity">−</button><input id="qty" value="1" style="width:60px;text-align:center"><button class="ghost" id="plus" aria-label="Increase quantity">+</button></div>
<div class="err" id="pde" role="alert"></div><p><button id="add">Add to cart</button> <button class="ghost" id="pdclose">Close</button></p></dialog>
<div class="card"><h3>Cart <span class="muted" id="count">(empty)</span></h3><div id="cart"></div>
<div class="row" style="align-items:end"><div><label for="coupon">Coupon code</label><input id="coupon"></div><div><button class="ghost" id="apply">Apply</button></div></div><div class="muted" id="cmsg"></div>
<p id="tot"></p><button id="checkout">Checkout</button></div>
<div class="card" id="co" hidden><h3>Shipping</h3><label for="sname">Full name</label><input id="sname"><label for="addr">Street address</label><input id="addr">
<div class="row"><div><label for="city">City</label><input id="city"></div><div><label for="zip">Postal code</label><input id="zip"></div></div>
<div style="margin-top:10px"><label style="display:inline;font-weight:400"><input type="radio" name="ship" value="standard" checked> Standard (free, 5–7 days)</label> <label style="display:inline;font-weight:400;margin-left:12px"><input type="radio" name="ship" value="express"> Express (€12, 1–2 days)</label></div>
<div class="err" id="coe" role="alert"></div><p><button id="place">Place order</button></p></div><div class="card ok" id="ok" hidden></div>`, `
const P=${JSON.stringify(PRODUCTS)};const $=(id)=>document.getElementById(id);let cart=[],coupon=null,cur=null,size=null,color=null;
const render=()=>{let l=P.filter(p=>(!$('cat').value||p.cat===$('cat').value)&&p.name.toLowerCase().includes($('q').value.toLowerCase()));if($('sort').value==='price-asc')l=[...l].sort((a,b)=>a.price-b.price);if($('sort').value==='price-desc')l=[...l].sort((a,b)=>b.price-a.price);
$('grid').innerHTML=l.map(p=>'<div class="prod"><b>'+p.name+'</b><div class="muted">'+p.cat+'</div><div>€'+p.price+'</div><button class="ghost" data-id="'+p.id+'">View</button></div>').join('')||'<p class="muted">No products match.</p>'};
['q','cat','sort'].forEach(i=>$(i).addEventListener('input',render));render();
$('grid').onclick=(e)=>{const id=e.target.dataset?.id;if(!id)return;cur=P.find(p=>p.id===id);size=null;color=null;$('pdn').textContent=cur.name;$('pdp').textContent='€'+cur.price;$('qty').value=1;$('pde').textContent='';
$('opts').innerHTML=cur.cat==='Shoes'?'<label for="size">Size</label><select id="size"><option value="">Choose size</option>'+[39,40,41,42,43,44].map(s=>'<option>'+s+'</option>').join('')+'</select><div style="margin-top:10px;font-weight:600;font-size:13px">Color: <span id="cname">choose</span></div>'+['black','blue','red'].map(c=>'<span class="swatch" role="radio" aria-checked="false" aria-label="'+c+'" tabindex="0" data-color="'+c+'" style="background:'+({black:'#222',blue:'#2f5bea',red:'#d33'})[c]+'"></span>').join(''):'';
$('pd').showModal()};
$('opts').onclick=(e)=>{const c=e.target.dataset?.color;if(!c)return;color=c;$('cname').textContent=c;document.querySelectorAll('.swatch').forEach(s=>{s.classList.toggle('on',s.dataset.color===c);s.setAttribute('aria-checked',s.dataset.color===c)})};
$('minus').onclick=()=>$('qty').value=Math.max(1,(+$('qty').value||1)-1);$('plus').onclick=()=>$('qty').value=(+$('qty').value||1)+1;$('pdclose').onclick=()=>$('pd').close();
$('add').onclick=()=>{if(cur.cat==='Shoes'){size=$('size').value;if(!size)return $('pde').textContent='Choose a size.';if(!color)return $('pde').textContent='Choose a color.'}const q=Math.max(1,parseInt($('qty').value)||1);
cart.push({id:cur.id,name:cur.name,price:cur.price,qty:q,size,color});$('pd').close();draw()};
const sub=()=>cart.reduce((n,i)=>n+i.price*i.qty,0);const ship=()=>document.querySelector('input[name=ship]:checked')?.value==='express'?12:0;
const draw=()=>{$('count').textContent=cart.length?'('+cart.reduce((n,i)=>n+i.qty,0)+' items)':'(empty)';$('cart').innerHTML=cart.map((i,k)=>'<div>'+i.qty+' × '+i.name+(i.size?' · size '+i.size:'')+(i.color?' · '+i.color:'')+' — €'+(i.price*i.qty)+' <button class="ghost" data-rm="'+k+'">Remove</button></div>').join('');
const s=sub(),d=coupon?Math.round(s*coupon.off*100)/100:0;$('tot').innerHTML='Subtotal €'+s+(d?' · Discount −€'+d:'')+' · Shipping €'+ship()+' · <b>Total €'+(s-d+ship()).toFixed(2)+'</b>'};
$('cart').onclick=(e)=>{if(e.target.dataset.rm!==undefined){cart.splice(+e.target.dataset.rm,1);draw()}};
$('apply').onclick=async()=>{const r=await fetch('/api/coupon?code='+encodeURIComponent($('coupon').value.trim()));const j=await r.json();coupon=j.ok?{code:$('coupon').value.trim().toUpperCase(),off:j.off}:null;$('cmsg').textContent=j.ok?'Coupon applied: '+Math.round(j.off*100)+'% off':'That code isn’t valid.';draw()};
document.addEventListener('change',(e)=>{if(e.target.name==='ship')draw()});
$('checkout').onclick=()=>{if(!cart.length)return;$('co').hidden=false;$('sname').focus()};
$('place').onclick=async()=>{for(const f of ['sname','addr','city','zip'])if(!$(f).value.trim())return $('coe').textContent='Fill in the shipping address.';
const r=await fetch('/api/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({items:cart,coupon:coupon?.code??null,shipping:document.querySelector('input[name=ship]:checked').value,name:$('sname').value,address:$('addr').value,city:$('city').value,zip:$('zip').value})});
const j=await r.json();$('co').hidden=true;$('ok').hidden=false;$('ok').innerHTML='<h3>Thank you!</h3><p>Order <b>'+j.order+'</b> is confirmed. Total charged: <b>€'+j.total.toFixed(2)+'</b></p>'};`);
}

function flightsPage(u) {
  const direct = u.searchParams.get('direct') === '1';
  const to = u.searchParams.get('to') || '';
  const sort = u.searchParams.get('sort') || 'dep';
  const pageNo = Math.max(1, parseInt(u.searchParams.get('page') || '1'));
  let list = FLIGHTS.filter((f) => (!direct || f.stops === 0) && (!to || f.to === to));
  list = [...list].sort((a, b) => (sort === 'price' ? a.price - b.price : a.dep.localeCompare(b.dep)));
  const pages = Math.max(1, Math.ceil(list.length / 6));
  const rows = list.slice((pageNo - 1) * 6, pageNo * 6);
  const q = (o) => '?' + new URLSearchParams({ to, direct: direct ? '1' : '', sort, page: String(pageNo), ...o }).toString();
  return page('Flights from Lisbon', `
<div class="card"><form method="get" class="row" style="align-items:end"><div><label for="to">To</label><select id="to" name="to"><option value="">Anywhere</option>${['Berlin', 'Paris', 'Madrid', 'Rome'].map((c) => `<option ${c === to ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
<div><label style="display:inline;font-weight:400"><input type="checkbox" name="direct" value="1" ${direct ? 'checked' : ''}> Direct flights only</label></div><input type="hidden" name="sort" value="${esc(sort)}"><div><button>Search</button></div></form></div>
<table><thead><tr><th>Flight</th><th>To</th><th><a href="${q({ sort: 'dep', page: '1' })}">Departs</a></th><th>Stops</th><th><a href="${q({ sort: 'price', page: '1' })}">Price</a></th><th></th></tr></thead><tbody>
${rows.map((f) => `<tr><td>${f.no}</td><td>${f.to}</td><td>${f.dep}</td><td>${f.stops === 0 ? 'Direct' : f.stops + ' stop' + (f.stops > 1 ? 's' : '')}</td><td>€${f.price}</td><td><button class="ghost" data-no="${f.no}">Details</button></td></tr>`).join('') || '<tr><td colspan="6">No flights.</td></tr>'}
</tbody></table><p>${Array.from({ length: pages }, (_, i) => (i + 1 === pageNo ? `<b>${i + 1}</b>` : `<a href="${q({ page: String(i + 1) })}">${i + 1}</a>`)).join(' · ')} ${pageNo < pages ? `· <a href="${q({ page: String(pageNo + 1) })}">Next →</a>` : ''}</p>
<dialog id="dlg"><h3 id="dt"></h3><div id="dd"></div><p><button id="dc">Close</button></p></dialog>`, `
const F=${JSON.stringify(FLIGHTS)};document.querySelector('tbody').onclick=(e)=>{const no=e.target.dataset?.no;if(!no)return;const f=F.find(x=>x.no===no);
document.getElementById('dt').textContent='Flight '+f.no+' · Lisbon → '+f.to;document.getElementById('dd').innerHTML='<p>Departs '+f.dep+' · '+(f.stops?f.stops+' stop(s)':'Direct')+'</p><p>Fare €'+f.price+'</p><p>Checked baggage allowance: <b>'+f.bag+'</b></p>';document.getElementById('dlg').showModal();
fetch('/api/flight-viewed',{method:'POST',body:f.no})};document.getElementById('dc').onclick=()=>document.getElementById('dlg').close();`);
}

function support(framePort) {
  const faq = Array.from({ length: 24 }, (_, i) => ({ q: `Question ${i + 1}: ${['How do I reset my password?', 'Can I change my plan?', 'Where is my invoice?', 'How do refunds work?'][i % 4]}`, a: i === 17 ? 'Refunds for double charges are issued within 3 business days.' : 'See your account settings.' }));
  return page('Support', `
<div class="card"><h2>Support</h2><p class="muted">Open a ticket below. Our FAQ:</p><div id="faq"></div><button class="ghost" id="more">Load more</button></div>
<div class="card"><iframe title="Contact form" src="http://127.0.0.1:${framePort}/widget" style="width:100%;height:480px;border:0"></iframe></div>`, `
const F=${JSON.stringify(faq)};let n=0;const more=()=>{n+=6;document.getElementById('faq').innerHTML=F.slice(0,n).map(f=>'<details><summary>'+f.q+'</summary><p>'+f.a+'</p></details>').join('');if(n>=F.length)document.getElementById('more').remove()};more();document.getElementById('more').onclick=more;`);
}

const widget = (mainOrigin) => `<!doctype html><html><head><meta charset="utf-8"><title>Contact</title><style>body{font:15px/1.5 system-ui;margin:0;padding:8px}</style></head><body>
<contact-form></contact-form><script>
class ContactForm extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'open'});r.innerHTML=\`<style>label{display:block;margin:8px 0 4px;font-weight:600;font-size:13px}input,select,textarea{font:inherit;width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px}button{margin-top:12px;padding:8px 16px;border:0;border-radius:8px;background:#2f5bea;color:#fff}.err{color:#c62828}</style>
<h3>Open a ticket</h3><label for="cat">Category</label><select id="cat"><option value="">Choose…</option><option>Account</option><option>Billing</option><option>Technical</option></select>
<label for="subj">Subject</label><input id="subj"><label for="msg">Message</label><textarea id="msg" rows="4"></textarea>
<label>Priority</label><label style="display:inline;font-weight:400"><input type="radio" name="pri" value="Low" checked style="width:auto"> Low</label> <label style="display:inline;font-weight:400"><input type="radio" name="pri" value="Normal" style="width:auto"> Normal</label> <label style="display:inline;font-weight:400"><input type="radio" name="pri" value="High" style="width:auto"> High</label>
<div class="err" id="err" role="alert"></div><button id="send">Send ticket</button><div id="ok"></div>\`;
const $=(i)=>r.getElementById(i);$('send').onclick=async()=>{if(!$('cat').value||!$('subj').value.trim()||!$('msg').value.trim()){$('err').textContent='Fill in category, subject and message.';return}
const res=await fetch('/api/ticket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({category:$('cat').value,subject:$('subj').value,message:$('msg').value,priority:r.querySelector('input[name=pri]:checked').value})});const j=await res.json();$('err').textContent='';$('ok').innerHTML='<p><b>Ticket '+j.ticket+' created.</b></p>'}}}
customElements.define('contact-form',ContactForm);</script></body></html>`;

function docs() {
  return page('Developer docs', `<div class="card"><h2>Connect your project</h2><p>Paste your project key below. You'll find it on the <a href="/keys" target="_blank">keys page</a> (opens in a new tab).</p>
<label for="key">Project key</label><input id="key"><div class="err" id="e" role="alert"></div><p><button id="save">Save key</button></p><div id="ok"></div></div>`, `
document.getElementById('save').onclick=async()=>{const k=document.getElementById('key').value.trim();const r=await fetch('/api/key',{method:'POST',body:k});const j=await r.json();
if(!j.ok){document.getElementById('e').textContent='That key isn’t right.';return}document.getElementById('e').textContent='';document.getElementById('ok').innerHTML='<p class="ok card">Connected to project <b>'+j.project+'</b>.</p>'};`);
}
const keys = () => page('Your keys', `<div class="card"><h2>Project keys</h2><table><tr><th>Project</th><th>Key</th></tr><tr><td>sandbox</td><td><code>pk_test_51xh0</code> (revoked)</td></tr><tr><td>orbit-demo</td><td><code>pk_live_7Q2M-ORBIT-4471</code></td></tr></table></div>`);

// ---------------------------------------------------------------------------- server
export function startSite({ port = 8765, framePort = 8766 } = {}) {
  const results = [];
  const record = (kind, data) => results.push({ kind, at: Date.now(), ...data });
  const body = (req) => new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
  const json = (res, o) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
  const html = (res, s) => (res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }), res.end(s));
  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/' || u.pathname === '/signup') return html(res, signup());
    if (u.pathname === '/shop') return html(res, shop());
    if (u.pathname === '/flights') return html(res, flightsPage(u));
    if (u.pathname === '/support') return html(res, support(framePort));
    if (u.pathname === '/docs') return html(res, docs());
    if (u.pathname === '/keys') return html(res, keys());
    if (u.pathname === '/api/signup') {
      const d = JSON.parse(await body(req));
      const code = 'CL-' + Buffer.from(`${d.email}|${d.plan}|${d.country}`).toString('base64').replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase();
      record('signup', { ...d, code });
      return json(res, { name: d.name, code });
    }
    if (u.pathname === '/api/coupon') {
      const off = COUPONS[(u.searchParams.get('code') || '').toUpperCase()];
      return json(res, off ? { ok: true, off } : { ok: false });
    }
    if (u.pathname === '/api/order') {
      const d = JSON.parse(await body(req));
      const sub = d.items.reduce((n, i) => n + i.price * i.qty, 0);
      const off = COUPONS[d.coupon] ?? 0;
      const total = Math.round((sub - Math.round(sub * off * 100) / 100 + (SHIPPING[d.shipping] ?? 0)) * 100) / 100;
      const order = 'ORD-' + (4100 + results.filter((r) => r.kind === 'order').length + 1);
      record('order', { ...d, total, order });
      return json(res, { order, total });
    }
    if (u.pathname === '/api/flight-viewed') return (record('flight-viewed', { no: await body(req) }), json(res, { ok: true }));
    if (u.pathname === '/api/ticket') {
      const d = JSON.parse(await body(req));
      const ticket = 'T-' + (9300 + results.filter((r) => r.kind === 'ticket').length + 1);
      record('ticket', { ...d, ticket });
      return json(res, { ticket });
    }
    if (u.pathname === '/api/key') {
      const k = (await body(req)).trim();
      const ok = k === 'pk_live_7Q2M-ORBIT-4471';
      record('key', { key: k, ok });
      return json(res, ok ? { ok: true, project: 'orbit-demo' } : { ok: false });
    }
    if (u.pathname === '/__results') return json(res, results);
    if (u.pathname === '/__reset') return (results.length = 0, json(res, { ok: true }));
    res.writeHead(404).end('not found');
  };
  const main = http.createServer(handler).listen(port, '127.0.0.1');
  // the contact widget lives on another origin, inside an iframe
  const frame = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/widget') return html(res, widget(`http://localhost:${port}`));
    if (u.pathname === '/api/ticket') {
      const d = JSON.parse(await body(req));
      const ticket = 'T-' + (9300 + results.filter((r) => r.kind === 'ticket').length + 1);
      record('ticket', { ...d, ticket });
      return json(res, { ticket });
    }
    res.writeHead(404).end('not found');
  }).listen(framePort, '127.0.0.1');
  return { results, FLIGHTS, PRODUCTS, close: () => (main.close(), frame.close()) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = startSite();
  console.log('bench site on http://localhost:8765 (iframe origin :8766)');
  process.on('SIGINT', () => (s.close(), process.exit(0)));
}
