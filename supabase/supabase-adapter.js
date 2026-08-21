// BUBU.Market live Supabase adapter. All commercial data crosses this boundary.
(function () {
  'use strict';
  const url = window.BUBU_SUPABASE_URL || '';
  const key = window.BUBU_SUPABASE_ANON_KEY || '';
  const sb = window.supabase && url && key ? window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  }) : null;
  const client = () => { if (!sb) throw new Error('Supabase is not configured'); return sb; };
  const dataOf = ({ data, error }) => { if (error) throw error; return data; };
  const money = n => 'UGX ' + Number(n || 0).toLocaleString('en-UG');
  const mediaUrl = path => !path ? '' : /^https?:/i.test(path) ? path
    : client().storage.from('media').getPublicUrl(path).data.publicUrl;
  const user = async () => dataOf(await client().auth.getUser()).user;
  async function accountRow() {
    const u = await user();
    if (!u) return null;
    return dataOf(await sb.from('accounts').select('id,role,district_id').eq('auth_user_id', u.id).maybeSingle());
  }

  const auth = {
    requestOtp(phone) { return client().auth.signInWithOtp({ phone }); },
    requestEmailOtp(email, create) {
      return client().auth.signInWithOtp({ email: String(email).trim(), options: { shouldCreateUser: !!create } });
    },
    async verifyOtp(target, token, channel) {
      return dataOf(await client().auth.verifyOtp(channel === 'email'
        ? { email: target, token, type: 'email' } : { phone: target, token, type: 'sms' }));
    },
    signIn(email, password) { return client().auth.signInWithPassword({ email, password }); },
    signUp(email, password, metadata) {
      return client().auth.signUp({ email, password, options: { data: metadata || {} } });
    },
    async verifyPlatformCode(email, code) {
      if (!window.BUBU_ALLOW_UNIVERSAL_OTP) throw new Error('Universal code is disabled');
      if (String(code) !== String(window.BUBU_UNIVERSAL_OTP || '')) throw new Error('Invalid code');
      return dataOf(await client().auth.signInWithPassword({
        email: String(email).trim(), password: String(window.BUBU_SEED_PASSWORD || '')
      }));
    },
    signOut() { return client().auth.signOut(); },
    async session() { return dataOf(await client().auth.getSession()).session; },
    onChange(fn) { return client().auth.onAuthStateChange(fn); }
  };

  async function loadAccount() {
    const u = await user();
    if (!u) return null;
    const a = dataOf(await sb.from('accounts').select(`*,account_registration(*),
      account_categories(category_id),addresses(*),payout_methods(*),handsets(*),
      account_users(*),documents(*),lead_preferences(*),subscriptions(*)`)
      .eq('auth_user_id', u.id).maybeSingle());
    if (!a) return null;
    const r = Array.isArray(a.account_registration) ? a.account_registration[0] || {} : a.account_registration || {};
    return {
      id: a.id, id_phone: a.phone, role: a.role,
      bizType: a.business_type === 'manufacturer' ? 'Manufacturer' : 'Trader',
      tier: a.tier === 'industry_leader' ? 'Industry leader' : a.tier === 'star_supplier' ? 'Star supplier' : '',
      company: a.company, trade: a.trade_name || a.company, initials: a.initials || '',
      person: a.account_users?.[0]?.full_name || u.user_metadata?.full_name || '',
      roleTitle: a.account_users?.[0]?.role_title || '', alt: a.alt_phone || '',
      email: a.email || u.email || '', addr: a.address || '', district: a.district_id || '',
      ursb: r.ursb_number || '', tin: r.tin || '', licence: r.trading_licence || '',
      nin: r.director_nin || '', vatNumber: r.vat_number || '',
      verificationState: r.overall_state || 'unverified', cats: (a.account_categories || []).map(x => x.category_id),
      about: a.about || '', coverage: a.coverage || '', nature: a.nature_of_business || '',
      staffCount: a.staff_count || '', turnover: a.turnover || '', brands: a.brands || '',
      spend: money(a.spend_12m), suppliers: String(a.supplier_count || 0),
      addresses: a.addresses || [], payoutMethods: a.payout_methods || [], handsets: a.handsets || [],
      documents: a.documents || [], leadPreferences: a.lead_preferences?.[0] || null,
      subscription: a.subscriptions?.[0] || null
    };
  }

  async function searchProducts({ query = '', category = null, mine = false, limit = 100 } = {}) {
    let q = sb.from('products').select(`*,accounts!products_supplier_id_fkey(company,district_id),
      media(storage_path,approved),product_specs(key,value,sort)`).order('updated_at', { ascending: false }).limit(limit);
    if (mine) { const a = await accountRow(); if (!a) return []; q = q.eq('supplier_id', a.id); }
    else q = q.eq('status', 'published');
    if (query) q = q.ilike('name', '%' + query.replace(/[%_]/g, '') + '%');
    if (category) q = q.eq('category_id', category);
    return (dataOf(await q) || []).map(p => ({
      id: p.id, supplierId: p.supplier_id, name: p.name, cat: p.category_id, family: p.family || '',
      description: p.description || '', price: Number(p.price), unit: p.unit, moq: Number(p.moq),
      brand: p.brand || '', status: p.status, rating: Number(p.rating || 0), orders: Number(p.order_count || 0),
      views: Number(p.view_count || 0), supplier: p.accounts?.company || '', loc: p.accounts?.district_id || '',
      photo: mediaUrl(p.media?.[0]?.storage_path), img: mediaUrl(p.media?.[0]?.storage_path), specs: p.product_specs || []
    }));
  }
  async function saveProduct(body) {
    const a = await accountRow();
    if (!a || a.role !== 'supplier') throw new Error('Supplier account required');
    const specs = body.specs || [];
    let categoryId = body.category_id || null;
    if (categoryId) {
      const categories = dataOf(await sb.from('categories').select('id,name')) || [];
      const wanted = String(categoryId).toLowerCase();
      const match = categories.find(c => c.id === categoryId || c.name.toLowerCase() === wanted)
        || categories.find(c => wanted.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(wanted.split('>')[0].trim()));
      categoryId = match ? match.id : null;
    }
    const row = { supplier_id: a.id, name: body.name, category_id: categoryId,
      family: body.family || null, description: body.description || null, price: Number(body.price),
      unit: body.unit, moq: Number(body.moq || 1), brand: body.brand || null, status: body.status || 'draft' };
    const saved = body.id
      ? dataOf(await sb.from('products').update(row).eq('id', body.id).eq('supplier_id', a.id).select().single())
      : dataOf(await sb.from('products').insert(row).select().single());
    if (body.id) dataOf(await sb.from('product_specs').delete().eq('product_id', saved.id));
    if (specs.length) dataOf(await sb.from('product_specs').insert(specs.map((s, i) => ({
      product_id: saved.id, key: s.key || s[0], value: s.value || s[1], sort: i }))));
    return saved;
  }
  const setProductStatus = async (id, status) => dataOf(await sb.from('products').update({ status }).eq('id', id).select().single());
  const deleteProduct = async id => dataOf(await sb.from('products').delete().eq('id', id));

  async function offersFor(productId) {
    return (dataOf(await sb.from('product_offers').select('*').eq('product_id', productId)) || []).map(o => ([
      o.supplier, o.district_id, Number(o.price), o.moq + ' ' + o.unit, null, !!o.verified, Number(o.years_on_platform || 0)
    ]));
  }
  async function revealContact({ requirementId = null, productId = null }) {
    return dataOf(await sb.rpc('reveal_contact', { p_requirement: requirementId, p_product: productId }));
  }
  async function myBuyLeads() {
    return (dataOf(await sb.rpc('my_buy_leads')) || []).map(r => ({ id: r.id, title: r.title,
      cat: r.category_id, qty: r.quantity + ' ' + r.quantity_unit, loc: r.district_id,
      neededBy: r.needed_by, value: money(r.estimated_value), spec: r.specification,
      purpose: r.purpose, createdAt: r.created_at }));
  }
  async function postRequirement(body) {
    const a = await accountRow();
    return dataOf(await sb.from('requirements').insert({ ...body, buyer_id: a.id }).select().single());
  }
  async function saveQuote(body, send) {
    const a = await accountRow();
    return dataOf(await sb.from('quotes').upsert({ ...body, supplier_id: a.id, state: send ? 'sent' : 'draft' },
      { onConflict: 'requirement_id,supplier_id' }).select().single());
  }
  const sendQuote = body => saveQuote(body, true);

  async function loadConversations() {
    const a = await accountRow(); if (!a) return [];
    const rows = dataOf(await sb.from('conversations').select(`*,buyer:buyer_id(company,phone,district_id),
      supplier:supplier_id(company,phone,district_id),requirement:requirement_id(title),
      messages(id,sender_id,direction,channel,body,sent_at,read_at)`).order('last_message_at', { ascending: false })) || [];
    return rows.map(c => {
      const other = a.id === c.buyer_id ? c.supplier : c.buyer;
      const messages = (c.messages || []).sort((x, y) => String(x.sent_at).localeCompare(String(y.sent_at)));
      const last = messages[messages.length - 1];
      return Object.assign([other?.company || '', '', other?.district_id || '', other?.phone || '',
        last?.body || '', c.requirement?.title || '', c.last_message_at ? new Date(c.last_message_at).toLocaleDateString('en-GB') : ''],
        { id: c.id, messages, labels: c.labels || [], other });
    });
  }
  async function sendMessage(conversationId, body) {
    const a = await accountRow();
    return dataOf(await sb.from('messages').insert({ conversation_id: conversationId, sender_id: a.id,
      direction: 'out', channel: 'app', body: String(body).trim() }).select().single());
  }
  async function startConversation(supplierId, requirementId) {
    const a = await accountRow();
    if (!a || a.role !== 'buyer') throw new Error('Buyer account required');
    return dataOf(await sb.from('conversations').upsert({ supplier_id: supplierId, buyer_id: a.id,
      requirement_id: requirementId || null }, { onConflict: 'supplier_id,buyer_id,requirement_id' }).select().single());
  }
  function subscribeConversation(id, fn) {
    return sb.channel('conversation:' + id).on('postgres_changes', { event: 'INSERT', schema: 'public',
      table: 'messages', filter: 'conversation_id=eq.' + id }, p => fn(p.new)).subscribe();
  }

  const registerBuyer = async profile => dataOf(await sb.rpc('create_buyer_profile', profile));
  const submitSupplierApplication = async profile => dataOf(await sb.rpc('submit_supplier_application', profile));
  async function updateProfile(body) {
    const a = await accountRow();
    return dataOf(await sb.from('accounts').update(body).eq('id', a.id).select().single());
  }
  async function purchasePlan(planCode, method, phone) {
    return dataOf(await sb.rpc('start_plan_purchase', { p_plan_code: planCode, p_method: method, p_phone: phone }));
  }

  const admin = {
    async applications() { return dataOf(await sb.from('applications').select(`*,accounts(company,role,district_id,email,
      account_registration(*),documents(*))`).eq('state', 'pending').order('submitted_at')); },
    approve: id => sb.rpc('approve_application', { p_app: id }),
    reject: (id, reason) => sb.rpc('reject_application', { p_app: id, p_reason: reason }),
    members: async () => dataOf(await sb.from('accounts').select('*,account_registration(overall_state)').order('created_at', { ascending: false })),
    categories: async () => dataOf(await sb.from('categories').select('*').order('sort')),
    saveCategory: async row => dataOf(await sb.from('categories').upsert(row).select().single()),
    plans: async () => dataOf(await sb.from('plans').select('*').eq('active', true).order('price'))
  };

  async function uploadMedia(file, { productId = null, kind = 'product' } = {}) {
    const a = await accountRow();
    const folder = kind === 'company' ? 'company' : kind === 'document' ? 'documents' : 'products';
    const path = folder + '/' + a.id + '/' + crypto.randomUUID() + '-' + String(file.name).replace(/[^a-zA-Z0-9._-]/g, '-');
    dataOf(await sb.storage.from('media').upload(path, file));
    const row = dataOf(await sb.from('media').insert({ account_id: a.id, product_id: productId,
      kind, storage_path: path, approved: false }).select().single());
    return { ...row, url: kind === 'document' ? '' : mediaUrl(path) };
  }
  async function uploadDocument(file, kind) {
    const a = await accountRow();
    const path = 'documents/' + a.id + '/' + crypto.randomUUID() + '-' + String(file.name).replace(/[^a-zA-Z0-9._-]/g, '-');
    dataOf(await sb.storage.from('media').upload(path, file));
    return dataOf(await sb.from('documents').insert({ account_id: a.id, kind: kind || 'other',
      reference: file.name, storage_path: path, state: 'pending' }).select().single());
  }

  async function bootstrap() {
    const session = await auth.session();
    if (!session) return { signedIn: false, account: null, products: await searchProducts({}) };
    const account = await loadAccount();
    const [products, ownProducts, conversations, leads] = await Promise.all([
      searchProducts({}), account?.role === 'supplier' ? searchProducts({ mine: true }) : [],
      loadConversations(), account?.role === 'supplier' ? myBuyLeads() : []
    ]);
    return { signedIn: true, account, products, ownProducts, orders: [], conversations, leads };
  }

  window.BUBU_API = { client: sb, auth, bootstrap, loadAccount, searchProducts, saveProduct,
    setProductStatus, deleteProduct, offersFor, revealContact, myBuyLeads, postRequirement,
    saveQuote, sendQuote, loadOrders: async () => [], loadConversations, startConversation, sendMessage,
    subscribeConversation, registerBuyer, submitSupplierApplication, updateProfile,
    purchasePlan, admin, uploadMedia, uploadDocument, mediaUrl };
})();
