const db = require('../../db/models')
const { createAudit } = require('../../utils/auditLog')
const { scalarStoreScope } = require('../../utils/tenantScope')
const SocialMedia = db.social_media

exports.getAllSocialMedia = async (req, res) => {
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)
  const { page = 1, size = 10 } = req.query
  const limit = parseInt(size)
  const offset = (parseInt(page) - 1) * limit

  try {
    const { count, rows: getAllCategory } = await SocialMedia.findAndCountAll({
      where: store ? { store } : {},
      limit: limit,
      offset: offset
    })

    return res.status(200).json({
      success: true,
      message: 'Success',
      totalItems: count,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      data: getAllCategory?.length > 0 ? getAllCategory : []
    })
  } catch {
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.addNewSocialMedia = async (req, res) => {
  const body = req.body

  try {
    const store = body.store || req.user?.store
    const findOneSocialMedia = await SocialMedia?.findOne({
      where: {
        name: body?.name,
        ...(store ? { store } : {})
      }
    })

    if (!findOneSocialMedia?.getDataValue) {
      const creadtedCategory = await SocialMedia.create({
        name: body.name,
        icon: body.icon,
        link: body.link,
        status: body.status || 'active',
        store: store
      })

      if (creadtedCategory.getDataValue) {
        await createAudit(
          req,
          'create',
          'social_media_config',
          creadtedCategory.id,
          'Created social_media_config: ' + creadtedCategory.id
        )

        return res.status(200).json({
          success: true,
          message: 'Social Media Berhasil Di Buat'
        })
      }
    } else {
      return res.status(403).json({
        success: false,
        message: 'Social Media Sudah Terdaftar'
      })
    }
  } catch {
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.editSocialMediaById = async (req, res) => {
  const { id } = req.params
  const body = req.body || {}

  if (!body.name) {
    return res.status(400).json({
      success: false,
      message: 'Nama social media wajib diisi'
    })
  }

  try {
    // IDOR fix: `store = body.store || req.user?.store` trusted the
    // client-supplied body value directly as the authorization boundary.
    // validateStoreAccess resolves requestedStore as query.store *or*
    // body.store (query wins), so an attacker who puts their own store in
    // the query string while a different store's id sits in the body
    // reaches this controller with that attacker-chosen store never
    // actually checked against req.user.store. scalarStoreScope always
    // derives from req.user.store for non-super-admin.
    const getDuplicate = await SocialMedia.findOne({
      where: {
        name: body.name,
        ...scalarStoreScope(req, {}),
        id: { [db.Sequelize.Op.ne]: id }
      }
    })

    if (!getDuplicate?.dataValues) {
      const [updated] = await SocialMedia?.update(
        {
          name: body?.name,
          icon: body?.icon,
          link: body?.link,
          status: body?.status
        },
        {
          where: scalarStoreScope(req, { id })
        }
      )

      // The response used to be unconditionally 200 regardless of
      // `updated` (the affected-row count) — harmless before this fix
      // since the unscoped WHERE always matched the row if it existed at
      // all, but now that the WHERE is store-scoped, 0 affected is the
      // real, expected outcome for a cross-tenant attempt and must not
      // be reported as success.
      if (!updated) {
        return res.status(404).json({
          success: false,
          message: 'Social media tidak ditemukan'
        })
      }

      await createAudit(
        req,
        'update',
        'social_media_config',
        id,
        'Updated social_media_config: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Sukses Ubah Social Media'
      })
    } else {
      return res.status(403).json({
        success: false,
        message: 'Social Media Sudah Tersedia'
      })
    }
  } catch {
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deleteSocialMediaById = async (req, res) => {
  const { id } = req.params

  try {
    // Same IDOR fix as editSocialMediaById.
    const getId = await SocialMedia.destroy({
      where: scalarStoreScope(req, { id })
    })

    if (getId) {
      await createAudit(
        req,
        'delete',
        'social_media_config',
        id,
        'Deleted social_media_config: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success Hapus Social Media'
      })
    } else {
      return res.status(403).json({
        success: false,
        message: 'Gagal Hapus Social Media'
      })
    }
  } catch {
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}
