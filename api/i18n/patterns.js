// Error messages built at runtime (template strings) and zod's own issue
// texts. Each entry recognises one shape in either language and renders it
// in Indonesian (`id`) and English (`en`) from the captured values.

const NOUNS = {
  Product: ['Produk', 'Product'],
  Ingredient: ['Bahan baku', 'Ingredient'],
  'Inventory item': ['Item persediaan', 'Inventory item'],
  Account: ['Akun', 'Account']
}

const both = (id, en) => ({ id, en })

const MESSAGE_PATTERNS = [
  [/^(Product|Ingredient|Inventory item|Account) (#?\S+) not found$/,
    (m) => both(`${NOUNS[m[1]][0]} ${m[2]} tidak ditemukan`, `${NOUNS[m[1]][1]} ${m[2]} not found`)],
  [/^Product (\S+) does not exist$/, (m) => both(`Produk ${m[1]} tidak ditemukan`, `Product ${m[1]} does not exist`)],
  [/^Product not found: (.+)$/, (m) => both(`Produk tidak ditemukan: ${m[1]}`, `Product not found: ${m[1]}`)],
  [/^Product (\S+) not found in original order$/,
    (m) => both(`Produk ${m[1]} tidak ada di pesanan asal`, `Product ${m[1]} not found in original order`)],
  [/^Produk ID (.+) tidak ditemukan$/, (m) => both(`Produk ID ${m[1]} tidak ditemukan`, `Product ID ${m[1]} not found`)],
  [/^(.+) already exists$/, (m) => both(`${m[1]} sudah ada`, `${m[1]} already exists`)],

  [/^Insufficient stock for ingredient "(.+)": have (.+), need (.+)$/,
    (m) => both(`Stok bahan baku "${m[1]}" tidak cukup: tersedia ${m[2]}, dibutuhkan ${m[3]}`,
      `Insufficient stock for ingredient "${m[1]}": have ${m[2]}, need ${m[3]}`)],
  [/^Insufficient (store )?stock for product #(\d+): have (.+), need (.+)$/,
    (m) => both(`Stok ${m[1] ? 'toko ' : ''}produk #${m[2]} tidak cukup: tersedia ${m[3]}, dibutuhkan ${m[4]}`,
      `Insufficient ${m[1] || ''}stock for product #${m[2]}: have ${m[3]}, need ${m[4]}`)],
  [/^Insufficient stock at source store for product "(.+)" \(SKU: (.+)\)$/,
    (m) => both(`Stok produk "${m[1]}" (SKU: ${m[2]}) di toko asal tidak cukup`,
      `Insufficient stock at source store for product "${m[1]}" (SKU: ${m[2]})`)],
  [/^Bahan baku tidak cukup: (.+) — tersedia (.+), dibutuhkan (.+)$/,
    (m) => both(m.input, `Not enough ingredient: ${m[1]} — available ${m[2]}, needed ${m[3]}`)],
  [/^Stok produk tidak cukup: (.+) — tersedia (.+), dibutuhkan (.+)$/,
    (m) => both(m.input, `Not enough product stock: ${m[1]} — available ${m[2]}, needed ${m[3]}`)],
  [/^Stok "(.+)" tidak mencukupi untuk bundle "(.+)"\. Tersedia: (.+), dibutuhkan: (.+)$/,
    (m) => both(m.input, `Not enough stock of "${m[1]}" for bundle "${m[2]}". Available: ${m[3]}, needed: ${m[4]}`)],
  [/^Stok "(.+)" tidak mencukupi\. Tersedia: (.+), diminta: (.+)$/,
    (m) => both(m.input, `Not enough stock of "${m[1]}". Available: ${m[2]}, requested: ${m[3]}`)],
  [/^Stok bahan baku "(.+)" tidak mencukupi\. Tersedia: (.+), dibutuhkan: (.+)$/,
    (m) => both(m.input, `Not enough stock of ingredient "${m[1]}". Available: ${m[2]}, needed: ${m[3]}`)],
  [/^Menu tidak tersedia: bahan tidak cukup untuk (.+)$/,
    (m) => both(m.input, `Menu unavailable: not enough ingredients for ${m[1]}`)],
  [/^Bundle "(.+)" tidak tersedia: produk "(.+)" sedang tidak tersedia$/,
    (m) => both(m.input, `Bundle "${m[1]}" is unavailable: product "${m[2]}" is currently unavailable`)],
  [/^Bundle not available: (.+)$/, (m) => both(`Bundle tidak tersedia: ${m[1]}`, m.input)],
  [/^Product in bundle "(.+)" not found$/, (m) => both(`Produk dalam bundle "${m[1]}" tidak ditemukan`, m.input)],

  [/^Cannot change status from "(.+)"(\. Only draft can be changed\.)?$/,
    (m) => both(`Status "${m[1]}" tidak dapat diubah${m[2] ? '. Hanya draft yang dapat diubah.' : ''}`, m.input)],
  [/^Cannot (delete|update) order with status "(.+)"$/,
    (m) => both(`Pesanan berstatus "${m[2]}" tidak dapat ${m[1] === 'delete' ? 'dihapus' : 'diubah'}`, m.input)],
  [/^Cannot (delete|update) stock opname with status "(.+)"\. Only draft can be (deleted|updated)\.$/,
    (m) => both(`Stok opname berstatus "${m[2]}" tidak dapat ${m[1] === 'delete' ? 'dihapus' : 'diubah'}. Hanya draft yang dapat ${m[1] === 'delete' ? 'dihapus' : 'diubah'}.`, m.input)],
  [/^Only pending PO can be sent to supplier\. Current status: (.+)$/,
    (m) => both(`Hanya PO berstatus menunggu yang dapat dikirim ke supplier. Status saat ini: ${m[1]}`, m.input)],
  [/^Goods request is already (.+)$/, (m) => both(`Permintaan barang sudah berstatus ${m[1]}`, m.input)],

  [/^Duplicate item\(s\) in (goods receipt|purchase order): (.+)$/,
    (m) => both(`Item duplikat di ${m[1] === 'goods receipt' ? 'penerimaan barang' : 'purchase order'}: ${m[2]}`, m.input)],
  [/^Over-receiving not allowed for (.+?): max (\S+) remaining \(ordered (\S+), tolerance (.+?)(?:, already received (\S+))?\)$/,
    (m) => both(`Penerimaan ${m[1]} melebihi batas: sisa maksimal ${m[2]} (dipesan ${m[3]}, toleransi ${m[4]}${m[5] ? `, sudah diterima ${m[5]}` : ''})`, m.input)],
  [/^Over-payment not allowed\. Remaining: (.+), attempting: (.+)$/,
    (m) => both(`Pembayaran melebihi sisa tagihan. Sisa: ${m[1]}, akan dibayar: ${m[2]}`, m.input)],
  [/^Over-payment not allowed\. Total paid: (.+), remaining: (.+), attempting to pay: (.+)$/,
    (m) => both(`Pembayaran melebihi sisa tagihan. Sudah dibayar: ${m[1]}, sisa: ${m[2]}, akan dibayar: ${m[3]}`, m.input)],
  [/^DP belum lunas\. DP: (.+), Dibayar: (.+)$/,
    (m) => both(m.input, `Down payment not settled. Down payment: ${m[1]}, paid: ${m[2]}`)],

  [/^PPN tax configuration is missing for this outlet \(store (\S+)\); configure an active PPN rate before selling$/,
    (m) => both(`Konfigurasi PPN untuk outlet ini (toko ${m[1]}) belum ada; atur tarif PPN aktif sebelum berjualan`, m.input)],
  [/^Ingredient "(.+)" does not belong to (?:store \S+|this store)$/,
    (m) => both(`Bahan baku "${m[1]}" bukan milik toko ini`, m.input)],
  [/^Product #(\d+) is not assigned to store (\S+)$/,
    (m) => both(`Produk #${m[1]} tidak terdaftar di toko ${m[2]}`, m.input)],
  [/^Outlet (\S+) does not sell this product$/, (m) => both(`Outlet ${m[1]} tidak menjual produk ini`, m.input)],
  [/^Item persediaan "(.+)" bukan milik outlet ini$/, (m) => both(m.input, `Inventory item "${m[1]}" does not belong to this outlet`)],
  [/^Item persediaan "(.+)" tidak aktif$/, (m) => both(m.input, `Inventory item "${m[1]}" is inactive`)],
  [/^Produk dengan (No|SKU) "(.+)" milik toko lain$/,
    (m) => both(m.input, `The product with ${m[1] === 'No' ? 'number' : 'SKU'} "${m[2]}" belongs to another store`)],
  [/^Anda tidak memiliki izin untuk mengimport (kategori|produk) ke toko "(.+)"$/,
    (m) => both(m.input, `You do not have permission to import ${m[1] === 'kategori' ? 'categories' : 'products'} into store "${m[2]}"`)],
  [/^Unit mismatch for ingredient "(.+)": BOM line uses "(.+)", ingredient base unit is "(.+)"$/,
    (m) => both(`Satuan resep untuk bahan baku "${m[1]}" tidak cocok: resep memakai "${m[2]}", satuan dasar bahan baku "${m[3]}"`, m.input)],
  [/^Quantity per sold unit must be a whole number from 1 to (\d+)$/,
    (m) => both(`Jumlah per unit terjual harus bilangan bulat dari 1 sampai ${m[1]}`, m.input)],

  [/^Refund amount \((.+)\) exceeds the remaining refundable amount \((.+)\)$/,
    (m) => both(`Nominal pengembalian (${m[1]}) melebihi sisa yang dapat dikembalikan (${m[2]})`, m.input)],
  [/^Cumulative return quantity for (.+) \((.+)\) exceeds original quantity \((.+)\)$/,
    (m) => both(`Total retur untuk ${m[1]} (${m[2]}) melebihi jumlah awal (${m[3]})`, m.input)],
  [/^Return quantity exceeds available: (.+)$/, (m) => both(`Jumlah retur melebihi yang tersedia: ${m[1]}`, m.input)],
  [/^(?:Quantity must be an integer|Invalid quantity) for product (\S+)$/,
    (m) => both(`Jumlah untuk produk ${m[1]} tidak valid`, m.input)],

  [/^Total debit \((.+)\) must equal total credit \((.+)\)$/,
    (m) => both(`Total debit (${m[1]}) harus sama dengan total kredit (${m[2]})`, m.input)],
  [/^Journal entry is unbalanced: debit (.+) != credit (.+)$/,
    (m) => both(`Jurnal tidak seimbang: debit ${m[1]} ≠ kredit ${m[2]}`, m.input)],
  [/^Cannot delete category: (\d+) supplier\(s\) still assigned to this category$/,
    (m) => both(`Kategori tidak dapat dihapus: masih ada ${m[1]} supplier di kategori ini`, m.input)],

  [/^Role masih dipakai (\d+) pengguna\..*$/,
    (m) => both(m.input, `The role is still used by ${m[1]} user(s). Move them to another role before deleting.`)],
  [/^Gagal import: (.+)$/, (m) => both(m.input, `Import failed: ${m[1]}`)],
  [/^Gagal validasi \((\d+)\): (.+)$/, (m) => both(m.input, `Validation failed (${m[1]}): ${m[2]}`)],
  [/^Format tidak didukung: (.+)$/, (m) => both(m.input, `Unsupported format: ${m[1]}`)],
  [/^(Backup|Restore) gagal: (.+)$/, (m) => both(m.input, `${m[1]} failed: ${m[2]}`)],
  [/^(Tanggal mulai|Tanggal berakhir) tidak valid$/,
    (m) => both(m.input, `Invalid ${m[1] === 'Tanggal mulai' ? 'start' : 'end'} date`)]
]

// zod issue texts, and the reasons the request schemas write themselves.
const REASON_PATTERNS = [
  [/^Required$|^required$/, () => both('wajib diisi', 'is required')],
  [/^must not be negative$/, () => both('tidak boleh negatif', 'must not be negative')],
  [/^must be a number$/, () => both('harus berupa angka', 'must be a number')],
  [/^must be a valid number or null$/, () => both('harus berupa angka atau kosong', 'must be a valid number or null')],
  [/^harus angka bulat$/, () => both('harus angka bulat', 'must be a whole number')],
  [/^Invalid email$/, () => both('email tidak valid', 'invalid email')],
  [/^Invalid date$/, () => both('tanggal tidak valid', 'invalid date')],
  [/^Invalid enum value\..*$/, () => both('pilihan tidak valid', 'invalid option')],
  [/^Expected \w+, received \w+$/, () => both('tipe data tidak valid', 'has an invalid type')],
  [/^maksimal (\d+) karakter$/, (m) => both(m.input, `at most ${m[1]} characters`)],
  [/^String must contain at most (\d+) character\(s\)$/, (m) => both(`maksimal ${m[1]} karakter`, `at most ${m[1]} characters`)],
  [/^String must contain at least (\d+) character\(s\)$/, (m) => both(`minimal ${m[1]} karakter`, `at least ${m[1]} characters`)],
  [/^Array must contain at least (\d+) element\(s\)$/, (m) => both(`minimal ${m[1]} item`, `at least ${m[1]} item(s)`)],
  [/^Number must be greater than or equal to (\S+)$/, (m) => both(`minimal ${m[1]}`, `must be at least ${m[1]}`)],
  [/^Number must be less than or equal to (\S+)$/, (m) => both(`maksimal ${m[1]}`, `must be at most ${m[1]}`)],
  [/^Number must be greater than (\S+)$/, (m) => both(`harus lebih dari ${m[1]}`, `must be greater than ${m[1]}`)],
  [/^Number must be less than (\S+)$/, (m) => both(`harus kurang dari ${m[1]}`, `must be less than ${m[1]}`)],
  [/^Expected integer, received float$/, () => both('harus bilangan bulat', 'must be a whole number')],
  [/^Passwords do not match$/, () => both('kata sandi tidak cocok', 'passwords do not match')]
]

module.exports = { MESSAGE_PATTERNS, REASON_PATTERNS }
