const { Op } = require('sequelize')

const USER_ATTRS = ['id', 'userName', 'fullName']

async function enrichAuditFields(db, records, { transaction } = {}) {
  if (!records || !Array.isArray(records)) return

  const idSet = new Set()
  const userNameSet = new Set()

  records.forEach((r) => {
    const dv = r?.dataValues || r
    if (!dv) return
    ;['createdBy', 'modifiedBy'].forEach((field) => {
      const raw = dv[field]
      if (raw === null || raw === undefined || raw === '') return
      const isNumeric = /^[0-9]+$/.test(String(raw))
      if (isNumeric) {
        const id = Number(raw)
        if (id > 0) idSet.add(id)
      } else {
        userNameSet.add(String(raw))
      }
    })
  })

  const usersById = new Map()
  const usersByUserName = new Map()

  if (idSet.size > 0) {
    const users = await db.user.findAll({
      where: { id: { [Op.in]: [...idSet] } },
      attributes: USER_ATTRS,
      paranoid: false,
      transaction
    })
    users.forEach((u) => {
      usersById.set(String(u.id), {
        id: u.id,
        userName: u.userName,
        fullName: u.fullName
      })
    })
  }

  if (userNameSet.size > 0) {
    const users = await db.user.findAll({
      where: { userName: { [Op.in]: [...userNameSet] } },
      attributes: USER_ATTRS,
      paranoid: false,
      transaction
    })
    users.forEach((u) => {
      usersByUserName.set(String(u.userName), {
        id: u.id,
        userName: u.userName,
        fullName: u.fullName
      })
    })
  }

  records.forEach((r) => {
    const dv = r?.dataValues || r
    if (!dv) return
    ;['createdBy', 'modifiedBy'].forEach((field) => {
      const raw = dv[field]
      if (raw === null || raw === undefined || raw === '') return

      const isNumeric = /^[0-9]+$/.test(String(raw))
      const info = isNumeric
        ? usersById.get(String(raw))
        : usersByUserName.get(String(raw))

      if (info) {
        dv[`${field}User`] = info
      } else if (isNumeric) {
        dv[`${field}User`] = {
          id: Number(raw),
          userName: null,
          fullName: null
        }
      } else {
        dv[`${field}User`] = {
          id: null,
          userName: String(raw),
          fullName: String(raw)
        }
      }
    })
  })
}

module.exports = { enrichAuditFields }
