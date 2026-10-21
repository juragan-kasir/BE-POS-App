const db = require('../../db/models')
const {
  uploadToCloudinary,
  deleteFromCloudinary
} = require('../../utils/cloudinaryStorage')
const { createAudit } = require('../../utils/auditLog')

const DEFAULT_TEMPLATE = {
  showStoreName: true,
  showAddress: true,
  showMemberInfo: true,
  showLogo: true,
  showSocialMedia: true,
  socialMediaVisibility: null,
  addressFieldsVisibility: null,
  memberFieldsVisibility: null,
  logo: null,
  footer: 'Terima kasih atas kunjungan Anda',
  paperSize: '58mm',
  fontSize: 'normal',
  fontFamily: 'monospace',
  lineSpacing: 'normal'
}

const invoiceController = {
  async getSetting(req, res) {
    try {
      const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)
      const setting = await db.invoice_setting.findOne({
        where: store ? { store } : {}
      })

      if (!setting) {
        return res.status(200).json({
          success: true,
          message: 'Success get invoice setting',
          data: { ...DEFAULT_TEMPLATE, isDefault: true }
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Success get invoice setting',
        data: setting
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async updateSetting(req, res) {
    try {
      const {
        store: bodyStore,
        showStoreName,
        showAddress,
        showMemberInfo,
        showLogo,
        showSocialMedia,
        socialMediaVisibility,
        addressFieldsVisibility,
        memberFieldsVisibility,
        footer,
        paperSize,
        fontSize,
        fontFamily,
        lineSpacing,
        removeLogo
      } = req.body

      // IDOR fix: `store` used to come straight from req.body with no
      // check against req.user.store. validateStoreAccess resolves
      // requestedStore as req.query.store *or* req.body.store (query
      // wins), so an attacker who puts their own store in the query
      // string while a different store's id sits in the body satisfies
      // that middleware while still reaching here with an
      // attacker-chosen body.store the middleware never actually
      // validated. Only super_admin may explicitly target another store.
      const store =
        req.user?.roleType === 'super_admin' ? bodyStore : req.user?.store

      let existing = await db.invoice_setting.findOne({ where: { store } })

      let logoUrl = existing?.logo || null

      if (removeLogo === 'true' || removeLogo === true) {
        if (existing?.logo) {
          await deleteFromCloudinary(existing.logo).catch(() => {})
        }
        logoUrl = null
      } else if (req.file) {
        if (existing?.logo) {
          await deleteFromCloudinary(existing.logo).catch(() => {})
        }
        try {
          logoUrl = await uploadToCloudinary(req.file.path, 'pos-app-invoice')
        } catch (cloudErr) {
          console.error('Cloudinary upload failed:', cloudErr)
        }
      }

      const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1'

      const payload = {
        showStoreName:
          showStoreName !== undefined
            ? toBool(showStoreName)
            : (existing?.showStoreName ?? true),
        showAddress:
          showAddress !== undefined
            ? toBool(showAddress)
            : (existing?.showAddress ?? true),
        showMemberInfo:
          showMemberInfo !== undefined
            ? toBool(showMemberInfo)
            : (existing?.showMemberInfo ?? true),
        showLogo:
          showLogo !== undefined
            ? toBool(showLogo)
            : (existing?.showLogo ?? true),
        showSocialMedia:
          showSocialMedia !== undefined
            ? toBool(showSocialMedia)
            : (existing?.showSocialMedia ?? true),
        socialMediaVisibility:
          socialMediaVisibility !== undefined
            ? socialMediaVisibility
            : (existing?.socialMediaVisibility ?? null),
        addressFieldsVisibility:
          addressFieldsVisibility !== undefined
            ? addressFieldsVisibility
            : (existing?.addressFieldsVisibility ?? null),
        memberFieldsVisibility:
          memberFieldsVisibility !== undefined
            ? memberFieldsVisibility
            : (existing?.memberFieldsVisibility ?? null),
        logo: logoUrl,
        footer:
          footer !== undefined
            ? footer
            : (existing?.footer ?? 'Terima kasih atas kunjungan Anda'),
        paperSize:
          paperSize !== undefined
            ? paperSize
            : (existing?.paperSize ?? '58mm'),
        fontSize:
          fontSize !== undefined
            ? fontSize
            : (existing?.fontSize ?? 'normal'),
        fontFamily:
          fontFamily !== undefined
            ? fontFamily
            : (existing?.fontFamily ?? 'monospace'),
        lineSpacing:
          lineSpacing !== undefined
            ? lineSpacing
            : (existing?.lineSpacing ?? 'normal'),
        modifiedBy: req.user?.id
      }

      if (existing) {
        await existing.update(payload)
        await createAudit(
          req,
          'update',
          'invoice_setting',
          existing.id,
          'Updated invoice_setting for store: ' + store
        )
      } else {
        payload.store = store
        payload.createdBy = req.user?.id
        existing = await db.invoice_setting.create(payload)
        await createAudit(
          req,
          'create',
          'invoice_setting',
          existing.id,
          'Created invoice_setting for store: ' + store
        )
      }

      return res.status(200).json({
        success: true,
        message: 'Success update invoice setting',
        data: existing
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async resetSetting(req, res) {
    try {
      let { stores, store } = req.body
      const userRole = req.user?.roleType
      const userStore = req.user?.store

      let storeIds = []
      if (stores && Array.isArray(stores)) {
        storeIds = stores
      } else if (store) {
        storeIds = [store]
      }

      if (storeIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Pilih minimal satu toko'
        })
      }

      if (userRole !== 'super_admin') {
        storeIds = storeIds.filter((id) => Number(id) === Number(userStore))
      }

      const resetPromises = storeIds.map(async (sid) => {
        const existing = await db.invoice_setting.findOne({
          where: { store: sid }
        })
        if (existing) {
          if (existing.logo) {
            await deleteFromCloudinary(existing.logo).catch(() => {})
          }
          await existing.update({
            ...DEFAULT_TEMPLATE,
            modifiedBy: req.user?.id
          })
          await createAudit(
            req,
            'reset',
            'invoice_setting',
            existing.id,
            'Reset invoice_setting to default for store: ' + sid
          )
        }
      })

      await Promise.all(resetPromises)

      return res.status(200).json({
        success: true,
        message: 'Pengaturan invoice berhasil direset ke default'
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  }
}

module.exports = invoiceController
