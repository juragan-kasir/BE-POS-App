'use strict'
module.exports = (sequelize, DataTypes) => {
  const PromoCampaign = sequelize.define(
    'promo_campaign',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.JSONB
      },
      // PGA-03 / ADR-02 (batch B11): the tenant that owns the campaign. NULL
      // only for a campaign of a store without a tenant; such a campaign
      // never applies to an outlet that has one.
      tenantId: {
        type: DataTypes.INTEGER
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      description: {
        type: DataTypes.TEXT
      },
      code: {
        type: DataTypes.STRING(50)
      },
      type: {
        allowNull: false,
        type: DataTypes.ENUM(
          'happy_hour',
          'birthday',
          'buy_x_get_y',
          'spend_get',
          'manual',
          'automatic'
        )
      },
      discountType: {
        type: DataTypes.ENUM('percentage', 'fixed', 'free_item', 'buy_x_get_y'),
        defaultValue: 'percentage'
      },
      discountValue: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      maxDiscount: {
        type: DataTypes.INTEGER
      },
      minPurchase: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      startDate: {
        allowNull: false,
        type: DataTypes.DATE
      },
      endDate: {
        allowNull: false,
        type: DataTypes.DATE
      },
      startTime: {
        type: DataTypes.TIME
      },
      endTime: {
        type: DataTypes.TIME
      },
      daysOfWeek: {
        type: DataTypes.JSONB
      },
      applicableTo: {
        type: DataTypes.ENUM(
          'all',
          'specific_products',
          'specific_categories',
          'specific_members'
        ),
        defaultValue: 'all'
      },
      applicableIds: {
        type: DataTypes.JSONB
      },
      maxUsageTotal: {
        type: DataTypes.INTEGER
      },
      maxUsagePerMember: {
        type: DataTypes.INTEGER
      },
      currentUsage: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      priority: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      isCombinable: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      status: {
        type: DataTypes.ENUM(
          'draft',
          'active',
          'paused',
          'expired',
          'cancelled'
        ),
        defaultValue: 'draft'
      },
      autoActivate: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      modifiedBy: {
        type: DataTypes.INTEGER
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'promo_campaign',
      tableName: 'promo_campaign'
    }
  )

  PromoCampaign.associate = function (models) {
    PromoCampaign.hasMany(models.promo_rule, {
      foreignKey: 'campaignId',
      as: 'rules'
    })
    PromoCampaign.hasMany(models.promo_reward, {
      foreignKey: 'campaignId',
      as: 'rewards'
    })
    PromoCampaign.hasMany(models.promo_usage, {
      foreignKey: 'campaignId',
      as: 'usages'
    })
  }

  return PromoCampaign
}
