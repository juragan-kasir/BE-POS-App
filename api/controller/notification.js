const { Op } = require('sequelize')
const db = require('../../db/models')
const { scalarStoreScope, isSuperAdmin } = require('../../utils/tenantScope')
const Notification = db.notification

// E2E audit (2026-10-31): only `admin` and `user` were filtered by store, so a
// kasir listed, counted and marked-all-read every tenant's notifications.
// Every role now reads its own scope: its store (or assigned stores), a
// tenant super_admin its tenant's stores, and a super_admin who picked a
// store (validated by validateStoreAccess) that store only.
const notificationScope = (req, where = {}) => {
  const scoped = scalarStoreScope(req, where)
  if (isSuperAdmin(req) && req.storeId != null) return { ...scoped, store: req.storeId }
  return scoped
}

exports.getAllNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 20, isRead, search } = req.query
    const offset = (page - 1) * limit

    const whereCondition = notificationScope(req)

    if (isRead !== undefined && isRead !== '') {
      whereCondition.isRead = isRead === 'true'
    }

    if (search) {
      whereCondition[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } }
      ]
    }

    const { count, rows } = await Notification.findAndCountAll({
      where: whereCondition,
      order: [['updatedAt', 'DESC']],
      offset,
      limit: parseInt(limit),
      include: [{ model: db.location, as: 'storeData', attributes: ['name'] }]
    })

    const data = rows.map((n) => {
      const notif = n.toJSON()
      notif.storeName = notif.storeData?.name || notif.store
      delete notif.storeData
      return notif
    })

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: data,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / parseInt(limit))
      }
    })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.count({ where: notificationScope(req, { isRead: false }) })

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: { unreadCount: count }
    })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params

    // IDOR fix: was findByPk(id) with no store filter — any authenticated
    // user could flip another store's notification to read. `store` is
    // nullable (a company-wide notification has store: null); unlike a
    // global promo campaign, marking a shared notification read carries no
    // real blast radius, so — unlike promo's global-mutation restriction —
    // null-store notifications stay readable/markable by everyone, not
    // just super_admin. Only a notification actually scoped to a
    // DIFFERENT store is excluded.
    const isSuperAdmin = req.user?.roleType === 'super_admin'
    const userStore = Number(req.user?.store)
    const where = isSuperAdmin
      ? { id }
      : {
          id,
          [Op.or]: [
            { store: Number.isFinite(userStore) ? userStore : -1 },
            { store: null }
          ]
        }

    const notification = await Notification.findOne({ where })
    if (!notification) {
      return res
        .status(404)
        .json({ success: false, message: 'Notification not found' })
    }

    await notification.update({ isRead: true })

    return res
      .status(200)
      .json({ success: true, message: 'Marked as read', data: notification })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.update(
      { isRead: true },
      { where: notificationScope(req, { isRead: false }) }
    )

    return res
      .status(200)
      .json({ success: true, message: 'All notifications marked as read' })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}
