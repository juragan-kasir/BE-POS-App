const { ThermalPrinter } = require('../service/thermalPrinter')
const db = require('../../db/models')

let printerInstance = null

function getPrinter(config = {}) {
  if (!printerInstance) {
    printerInstance = new ThermalPrinter(config)
  }
  return printerInstance
}

const thermalPrinterController = {
  async printReceipt(req, res) {
    try {
      const { orderId, storeId, printerConfig, testPrint = false } = req.body
      const safeOrderId = orderId ? String(orderId).trim() : null // codacy-ignore-line

      if (!safeOrderId && !testPrint) {
        return res.status(400).json({
          success: false,
          message: 'orderId atau testPrint diperlukan'
        })
      }

      const store = String( // codacy-ignore-line
        storeId || req.storeId || req.cookies?.store || req.user?.store || ''
      ).trim()
      if (!store) {
        return res.status(400).json({
          success: false,
          message: 'Store ID diperlukan'
        })
      }

      let receiptData = {}

      if (testPrint) {
        receiptData = {
          storeName: 'TEST STORE',
          storeAddress: 'Jl. Test No. 123',
          storePhone: '021-1234567',
          invoiceNo: 'TEST-001',
          date: new Date().toLocaleString('id-ID'),
          cashier: 'Test Kasir',
          items: [
            {
              nameProduct: 'Produk Test 1',
              quantity: 2,
              sellingPrice: 25000,
              totalPrice: 50000
            },
            {
              nameProduct: 'Produk Test 2',
              quantity: 1,
              sellingPrice: 15000,
              totalPrice: 15000
            }
          ],
          subtotal: 65000,
          discount: 0,
          tax: 6500,
          total: 71500,
          paymentMethod: 'Tunai',
          amountPaid: 100000,
          change: 28500,
          footerText: 'Ini adalah test print - Terima kasih!'
        }
      } else {
        // Fetch order data. The legacy `checkout` table has no detail model,
        // so use the canonical `order` / `order_item` association.
        const order = await db.order.findOne({
          where: { id: safeOrderId, ...(store ? { store } : {}) },
          include: [
            { model: db.order_item, as: 'items' },
            {
              model: db.location,
              as: 'storeData',
              attributes: ['id', 'name', 'address', 'phoneNumber']
            }
          ]
        })

        if (!order) {
          return res.status(404).json({
            success: false,
            message: 'Order tidak ditemukan'
          })
        }

        const storeInfo = order.storeData || (await db.location.findByPk(store))
        const total = Number(order.totalPrice) || 0

        receiptData = {
          storeName: storeInfo?.name || 'TOKO',
          storeAddress: storeInfo?.address || '',
          storePhone: storeInfo?.phoneNumber || '',
          invoiceNo: order.orderNumber || `INV-${order.id}`,
          date: new Date(order.createdAt).toLocaleString('id-ID'),
          cashier: order.cashierName || 'Kasir',
          items: (order.items || []).map((d) => ({
            nameProduct: d.productName,
            quantity: d.quantity,
            sellingPrice: d.price,
            totalPrice: d.totalPrice,
            variantName: d.options?.[0]?.name,
            notes: d.notes
          })),
          subtotal: Number(order.subTotal) || 0,
          discount: Number(order.discountAmount) || 0,
          tax: Number(order.taxAmount) || 0,
          total,
          paymentMethod: order.paymentMethodName || order.paymentMethod || 'Tunai',
          amountPaid: total,
          change: 0,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          notes: order.notes,
          qrCodeData: `${process.env.FRONTEND_URL || 'https://pos.app'}/receipt/${order.orderNumber || order.id}`,
          footerText: 'Terima kasih telah berbelanja!'
        }
      }

      // Initialize printer with config
      const printerConfigMerged = {
        type: 'auto',
        ...printerConfig
      }
      const printer = getPrinter(printerConfigMerged)

      const result = await printer.print(receiptData)

      // Log audit
      const { createAudit } = require('../../utils/auditLog')
      createAudit(
        req,
        'PRINT',
        'receipt',
        safeOrderId || 'test',
        `Printed receipt${testPrint ? ' (test)' : ''}`
      )

      return res.status(200).json({
        success: true,
        message: testPrint ? 'Test print berhasil' : 'Struk berhasil dicetak',
        data: result
      })
    } catch (error) {
      console.error('Print error:', error)
      return res.status(500).json({
        success: false,
        message: error.message || 'Gagal mencetak struk'
      })
    }
  },

  async testPrint(req, res) {
    return thermalPrinterController.printReceipt(req, res)
  },

  async getPrinterStatus(req, res) {
    try {
      const printer = getPrinter()
      const connected = await printer.connect().catch(() => false)
      void connected

      return res.status(200).json({
        success: true,
        data: {
          connected: printer.isConnected,
          type: printer.printerType,
          devicePath: printer.devicePath,
          ipAddress: printer.ipAddress
        }
      })
    } catch (error) {
      return res.status(200).json({
        success: true,
        data: {
          connected: false,
          error: error.message
        }
      })
    }
  },

  async configurePrinter(req, res) {
    try {
      const { type, devicePath, ipAddress, port, macAddress, columns } =
        req.body

      printerInstance = new ThermalPrinter({
        type: type || 'auto',
        devicePath,
        ipAddress,
        port,
        macAddress,
        columns: columns || 32
      })

      const connected = await printerInstance.connect().catch(() => false)

      return res.status(200).json({
        success: true,
        message: connected
          ? 'Printer terhubung'
          : 'Printer konfigurasi tersimpan (belum terhubung)',
        data: {
          connected: printerInstance.isConnected,
          type: printerInstance.printerType
        }
      })
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      })
    }
  }
}

module.exports = thermalPrinterController
