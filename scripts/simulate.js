// ponytail: simulation script, not production code
// Usage: node scripts/simulate.js all [password]
const http = require('http')
const BASE = 'http://localhost:5001'

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE)
    const opts = {
      hostname: url.hostname, // codacy-ignore-line
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Sim/1.0' }
    }
    if (token) opts.headers['Authorization'] = `Bearer ${token}`
    const r = http.request(opts, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          const j = JSON.parse(d)
          j._s = res.statusCode
          resolve(j)
        } catch {
          resolve({ _raw: d, _s: res.statusCode })
        }
      })
    })
    r.on('error', (e) => reject(new Error(`${path}: ${e.message}`)))
    if (body) r.write(JSON.stringify(body))
    r.end()
  })
}

const login = (u, p) => req('POST', '/auth/login', { userName: u, password: p })
const get = (p, t) => req('GET', p, null, t)
const post = (p, b, t) => req('POST', p, b, t)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  // DR-06: never a committed password — pass it as an argument or env.
  const pass = process.argv[3] || process.env.SIMULATE_PASSWORD
  if (!pass) throw new Error('Pass the password as the 2nd argument or set SIMULATE_PASSWORD')

  for (const { label, user, pw, sid } of [
    { label: 'LAWSON', user: 'admin_lawson', pw: pass, sid: 1 },
    { label: 'FAMILY MART', user: 'admin_family_mart', pw: pass, sid: 6 }
  ]) {
    console.log(`\n========== ${label} (store ${sid}) ==========`)

    const lr = await login(user, pw)
    if (!lr.token) {
      console.log(`LOGIN FAILED:`, lr.message)
      continue
    }
    const token = lr.token
    console.log(`Logged in: ${lr.user.storeName}`)

    // Category
    const catName = `${label} Mie`
    const cat = await post(
      '/category/add-new-category',
      {
        name: catName,
        description: `Kategori untuk ${label}`,
        value: catName.toLowerCase().replace(/\s+/g, '-'),
        status: 'active',
        store: [sid]
      },
      token
    )
    console.log(
      `Category "${catName}": ${cat.success || cat.message === 'Category Sudah Terdaftar' ? 'OK' : cat.message}`
    )
    await sleep(100)

    const cats = await get(
      `/category/get-category-all?page=1&limit=100&status=all`,
      token
    )
    const mieCat = cats.data?.find((c) => c.name === catName)

    // Supplier — use create response directly, else search
    const supName = `Supplier ${label}`
    const supId = sid * 100 + 1
    const supRes = await post(
      '/supplier/',
      {
        name: supName,
        phone: `08${String(supId).padStart(10, '0')}`,
        address: `Alamat ${label}`,
        contactPerson: `CP ${label}`,
        status: 'active'
      },
      token
    )
    let ourSup = supRes.success && supRes.data?.id ? supRes.data : null
    if (!ourSup) {
      const sups = await get('/supplier/?limit=100', token)
      ourSup = Array.isArray(sups.data)
        ? sups.data.find((s) => s.name.toLowerCase() === supName.toLowerCase())
        : null
    }
    console.log(
      `Supplier "${supName}": ${ourSup ? 'OK' : supRes.message || JSON.stringify(supRes)}`
    )
    console.log(`Supplier ID: ${ourSup?.id || 'N/A'}`)

    // Product
    const isLawson = sid === 1
    const prodName = isLawson
      ? 'Mie Dok-Dok Ala Warmindo'
      : 'Mie Tek Tek Ala Warmindo'
    const pPayload = isLawson
      ? {
          nameProduct: prodName,
          description: 'Indomie Nyemek ala Warmindo',
          category: String(mieCat?.id || ''),
          price: '15000',
          costPrice: '8000',
          status: 'active',
          unit: 'porsi',
          baseUnit: 'porsi',
          conversionFactor: '1',
          store: [sid],
          tipeProduk: 'menu',
          supplier: String(ourSup?.id || ''),
          composition: [
            { name: 'Indomie', qty: '1', unit: 'bungkus' },
            { name: 'Telur', qty: '1', unit: 'butir' },
            { name: 'Bakso', qty: '1', unit: 'buah' },
            { name: 'Bawang Putih', qty: '1', unit: 'siung' },
            { name: 'Bawang Merah', qty: '2', unit: 'siung' },
            { name: 'Cabe', qty: '4', unit: 'buah' },
            { name: 'Sawi', qty: '1', unit: 'ikat' },
            { name: 'Kobis', qty: '1', unit: 'ikat' },
            { name: 'Kecap', qty: '1', unit: 'sdm' },
            { name: 'Saus Sambal', qty: '1', unit: 'sdm' },
            { name: 'Air', qty: '200', unit: 'ml' }
          ]
        }
      : {
          nameProduct: prodName,
          description: 'Mie Tek Tek ala Warmindo - 2 porsi',
          category: String(mieCat?.id || ''),
          price: '25000',
          costPrice: '12000',
          status: 'active',
          unit: 'porsi',
          baseUnit: 'porsi',
          conversionFactor: '1',
          store: [sid],
          tipeProduk: 'menu',
          supplier: String(ourSup?.id || ''),
          composition: [
            { name: 'Indomie Goreng', qty: '2', unit: 'bungkus' },
            { name: 'Sawi', qty: '1', unit: 'ikat' },
            { name: 'Saus Sambal', qty: '4', unit: 'sdm' },
            { name: 'Kecap Manis', qty: '2', unit: 'sdm' },
            { name: 'Telur', qty: '2', unit: 'butir' },
            { name: 'Minyak Goreng', qty: '2', unit: 'sdm' },
            { name: 'Cabe Rawit', qty: '4', unit: 'buah' },
            { name: 'Air', qty: '100', unit: 'ml' }
          ]
        }

    const pr = await post('/product/add-product', pPayload, token)
    console.log(
      `Product "${prodName}": ${pr.success ? 'OK' : pr.message === 'Product with this name already exists.' ? 'OK (already exists)' : pr.message}`
    )
    await sleep(200)

    // Get product ID
    let ourProd = null
    for (const ep of ['get-product-all', 'get-product']) {
      const prods = await get(`/product/${ep}?page=1&limit=100`, token)
      ourProd = Array.isArray(prods.data)
        ? prods.data.find((p) => p.name === prodName)
        : null
      if (ourProd) break
    }
    console.log(`Product ID: ${ourProd?.id || 'N/A'}`)

    // Purchase Order (draft to skip Zod dueDate stripping)
    if (ourSup?.id) {
      const po = await post(
        '/purchase-order/create',
        {
          store: sid,
          supplier: ourSup.id,
          items: pPayload.composition.map((c) => ({
            product: ourProd?.id || 1,
            productName: c.name,
            quantity: Math.ceil(Number(c.qty) * 20),
            price: 1000,
            unit: c.unit || 'pcs'
          })),
          notes: `Initial stock for ${prodName}`,
          status: 'draft'
        },
        token
      )
      console.log(
        `Purchase Order: ${po.success ? 'OK (draft)' : po.message || JSON.stringify(po)}`
      )
    }

    // Category filter verification
    const fc = await get(
      `/category/get-category-all?page=1&limit=100&status=all`,
      token
    )
    const otherCats =
      fc.data?.filter((c) => {
        const st = c.store || []
        return st.length > 0 && !st.some((s) => s.id === sid)
      }) || []
    console.log(
      `Category filter: ${fc.data?.length || 0} total, ${otherCats.length} other-store (should be 0 for non-super_admin)`
    )

    console.log(`========== ${label} DONE ==========`)
  }

  console.log('\n=== SIMULATION COMPLETE ===')
}

run().catch(console.error)
