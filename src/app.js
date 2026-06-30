'use strict';

const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { ok } = require('./utils/response');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

const authRoutes = require('./modules/auth/auth.routes');
const usersRoutes = require('./modules/users/users.routes');
const rolesRoutes = require('./modules/roles/roles.routes');
const permissionsRoutes = require('./modules/permissions/permissions.routes');
const catalogRoutes = require('./modules/catalog/catalog.routes');
const appmoduleRoutes = require('./modules/appmodule/appmodule.routes');
const ordersRoutes = require('./modules/orders/orders.routes');
const technicalRoutes = require('./modules/technical/technical.routes');
const gomsetRoutes = require('./modules/gomset/gomset.routes');
const planningRoutes = require('./modules/planning/planning.routes');
const productionRoutes = require('./modules/production/production.routes');
const qualityRoutes = require('./modules/quality/quality.routes');
const deliveryRoutes = require('./modules/delivery/delivery.routes');
const wfconfigRoutes = require('./modules/wfconfig/wfconfig.routes');
const dashboardRoutes = require('./modules/dashboard/dashboard.routes');
//const erpsyncRoutes = require('./modules/erpsync/erpsync.routes');

const app = express();

app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Phục vụ file đã upload (ảnh avatar...). URL public thật do PUBLIC_BASE_URL quyết định;
// dòng này cho phép truy cập trực tiếp qua chính backend (hữu ích khi test local).
app.use('/uploads', express.static(require('path').join(env.upload.root)));

// Health check
app.get('/api/health', (req, res) => ok(res, { status: 'up', time: new Date().toISOString() }, 'OK'));

// Modules
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/modules', appmoduleRoutes);
app.use('/api/phan-in', ordersRoutes);
app.use('/api/ready', technicalRoutes);
app.use('/api/gom-set', gomsetRoutes);
app.use('/api/planning', planningRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/quality', qualityRoutes);
app.use('/api/giao-hang', deliveryRoutes);
app.use('/api/wf', wfconfigRoutes);
app.use('/api/dashboard', dashboardRoutes);
//app.use('/api/erp', erpsyncRoutes);

// 404 + error
app.use(notFound);
app.use(errorHandler);

module.exports = app;
