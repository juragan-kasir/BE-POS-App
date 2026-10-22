const db = require('../../db/models')
const { recordAudit, AUDIT_ACTIONS } = require('../../utils/auditLog')

const receiptController = {
  async getOrderReceipt(req, res) {
    try {
      const { orderId } = req.params
      const store = req.storeId || req.cookies.store || req.user?.store

      const order = await db.order.findOne({
        where: { id: orderId, ...(store ? { store } : {}) },
        include: [
          {
            model: db.order_item,
            as: 'items'
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name', 'address', 'phoneNumber']
          }
        ]
      })

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Order not found' })
      }

      await recordAudit({
        req,
        action: AUDIT_ACTIONS.RECEIPT_READ,
        entity: 'order',
        entityId: Number(order.id),
        description: `Receipt read for order ${order.orderNumber || order.id}`,
        storeId: req.storeId ?? req.user?.store ?? store
      })

      const receipt = {
        storeName: order.storeData?.name || 'Toko',
        storeAddress: order.storeData?.address || '',
        storePhone: order.storeData?.phoneNumber || '',
        orderNumber: order.orderNumber || `INV-${order.id}`,
        cashier: order.cashierName || '-',
        customer: order.customerName || 'Umum',
        date: order.createdAt
          ? new Date(order.createdAt).toLocaleString('id-ID')
          : '',
        items: (order.items || []).map((item) => ({
          name: item.productName || '-',
          qty: item.quantity || 0,
          price: item.price || 0,
          total: item.totalPrice || item.quantity * item.price || 0
        })),
        subtotal: order.subTotal || 0,
        discount: order.discountAmount || 0,
        tax: order.taxAmount || 0,
        total: order.totalPrice || order.finalAmount || 0,
        paymentMethod: order.paymentMethod || order.typePayment || 'Tunai',
        cashAmount: order.cashAmount || order.total || 0,
        changeAmount: order.changeAmount || 0,
        footer: 'Terima kasih atas kunjungan Anda'
      }

      return res.status(200).json({
        success: true,
        message: 'Success get receipt data',
        data: receipt
      })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = receiptController
