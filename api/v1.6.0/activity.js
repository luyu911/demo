/*
 * @Author: luyu
 * @Date: 2022-06-06 18:35:00
 * @LastEditors: luyu
 * @FilePath: /steam-box-server/api/v1.6.0/activity.js
 * @Description: 活动相关接口
 */
let express = require('express');
const router = express.Router();
module.exports = router;

const fs = require('fs');
const path = require('path');
const mysql = require('../../plugins/mysql');
const action = require('../../plugins/actions_limit');

// 读取配置文件
function activity_config() {
    try{
        const json = fs.readFileSync(path.join(__dirname, '../../json/activity.json'),'utf-8');
        return JSON.parse(json);
    }catch (e) {
        throw Error('读取 activity 配置文件失败');
    }
}

// 活动状态
router.get('/activity_stat', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let have_signed = false;
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        // 查询当前用户剩余积分
        let [points_rows] = await box_db_con.query('select remain from user_points where uid = ?', uid);
        let remain_points = points_rows[0].remain || 0;
        // 查询今天观看的广告数量
        let [reward_ad_rows] = await box_db_con.query('select reward_ad_id from reward_ad where uid = ? and success = 1 and date(create_time) = curdate()', uid);
        res.json({
            success: true,
            result: {
                remain_points,
                reward_ad_stat: {
                    limit: activity_config().reward_ad.limit,
                    watched: reward_ad_rows.length,
                    reward_points: '5~10'
                }
            }
        });
    } catch (err) {
        res.json({
            have_signed,
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 每日签到功能
router.post('/daily_sign', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let have_signed = false;
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        let [user_info_rows] = await box_db_con.query('select phone,last_sign_date from user_info where uid = ?', uid);
        // 判断是否绑定手机号
        if (!user_info_rows[0].phone) {
            throw Error('每日签到奖励需要您先绑定手机号');
        }
        let last_sign_date = user_info_rows[0].last_sign_date;
        // 判断是否是今天
        if (new Date(last_sign_date).toDateString() === new Date().toDateString()) {
            have_signed = true;
            throw Error('今天已经签到过了');
        }
        // 更新今天签到时间
        await box_db_con.query('update user_info set last_sign_date = ? where uid = ?', [new Date(), uid]);
        // 随机奖励积分 2-5点
        // let bonus_points = Math.floor(Math.random() * (5 - 2 + 1)) + 2;
        // 随机奖励积分 24-30点
        let bonus_points = Math.floor(Math.random() * (30 - 24 + 1)) + 24;
        // 2023-4-21 00:00:00以后，每日签到恢复到 2-4点
        if (new Date() > new Date('2023-04-21 00:00:00')) {
            bonus_points = Math.floor(Math.random() * (4 - 2 + 1)) + 2;
        }
        await box_db_con.query('update user_points set remain = remain + ? where uid = ?', [bonus_points, uid]);
        // 插入积分记录
        let points_record_data = {
            uid,
            record_type: 1,
            num: bonus_points,
            remark: `[每日签到] 奖励积分[${bonus_points}]`,
        }
        await box_db_con.query('insert into points_record set ?', points_record_data);

        res.json({
            success: true,
            result: `签到成功,奖励 ${bonus_points} 积分`,
        });
    } catch (err) {
        res.json({
            have_signed,
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 账号绑定奖励
router.post('/bind_award', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let type = req.body.type;
    // 目前仅支持手机号和邮箱
    ['phone', 'email'].includes(type) || (() => {
        throw Error('缺少必填参数')
    })()
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        // 检查是否已经绑定
        let [user_rows] = await box_db_con.query('select phone,email from user_info where uid = ?', uid);
        if (!user_rows[0][type]) {
            throw Error('还未绑定该类型账号');
        }
        let award_id = `bind_${type}`;
        // 检查奖励表是否已经领取过奖励
        let [award_rows] = await box_db_con.query('select rid from award_record where uid = ? and award_id = ?', [uid, award_id]);
        if (award_rows.length > 0) {
            throw Error('已经领取过奖励');
        }
        // 获取奖励任务详情，要求在start_time和end_time之间
        let [award_task_rows] = await box_db_con.query('select * from award_task where award_id = ? and start_time <= ? and end_time >= ?', [award_id, new Date(), new Date()]);
        if (award_task_rows.length === 0) {
            throw Error('该奖励任务未在进行');
        }
        // 更新奖励记录
        let bonus_points = award_task_rows[0].bonus_points;
        let bonus_name = award_task_rows[0].name;
        let remark = `[${bonus_name}] 奖励积分[${bonus_points}]`;
        let award_record_data = {uid, award_id, remark};
        await box_db_con.query('insert into award_record set ?', award_record_data);
        // 更新积分
        await box_db_con.query('update user_points set remain = remain + ? where uid = ?', [bonus_points, uid]);
        // 插入积分记录
        let points_record_data = {
            uid,
            record_type: 1,
            num: bonus_points,
            remark,
        }
        await box_db_con.query('insert into points_record set ?', points_record_data);

        res.json({
            success: true,
            result: 'ok',
            msg: remark
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 用户邀请奖励，被邀请人领取奖励
router.post('/invite_award', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let farther_uname = req.body.farther_uname || '';
    /^(?=.*[a-zA-Z])[a-zA-Z0-9_-]{3,32}$/.test(farther_uname) || (() => {
        throw Error('[格式错误]邀请人用户名')
    })();
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        let award_id = 'i_am_invited';
        // 检查是否绑定手机
        let [user_rows] = await box_db_con.query('select phone from user_info where uid = ?', uid);
        if (!user_rows[0].phone) {
            throw Error('绑定手机号后才能领取此奖励');
        }
        // 检查父用户是否存在，且不是自己
        let [farther_rows] = await box_db_con.query('select uid from user_info where username = ? and uid != ?', [farther_uname, uid]);
        if (farther_rows.length === 0) {
            throw Error('邀请人用户名不存在');
        }
        let farther_uid = farther_rows[0].uid;

        // 检查奖励表是否已经领取过奖励
        let [award_rows] = await box_db_con.query('select rid from award_record where uid = ? and award_id = ?', [uid, award_id]);
        if (award_rows.length > 0) {
            throw Error('该奖励仅可领取一次');
        }
        // 获取奖励任务详情，要求在start_time和end_time之间
        let [award_task_rows] = await box_db_con.query('select * from award_task where award_id = ? and start_time <= ? and end_time >= ?', [award_id, new Date(), new Date()]);
        if (award_task_rows.length === 0) {
            throw Error('该奖励任务未在进行');
        }
        // 更新奖励记录
        let bonus_points = award_task_rows[0].bonus_points;
        let bonus_name = award_task_rows[0].name;
        let remark = `[${bonus_name}] 邀请者用户名[${farther_uname}] 奖励积分[${bonus_points}]`;
        let award_record_data = {uid, award_id, remark};
        await box_db_con.query('insert into award_record set ?', award_record_data);
        // 更新积分
        await box_db_con.query('update user_points set remain = remain + ? where uid = ?', [bonus_points, uid]);
        // 插入积分记录
        let points_record_data = {
            uid,
            record_type: 1,
            num: bonus_points,
            remark,
        }
        await box_db_con.query('insert into points_record set ?', points_record_data);

        // 给父用户奖励，小于十次可以继续奖励
        let farther_award_id = 'invite_others';
        let [farther_award_rows] = await box_db_con.query('select rid from award_record where uid = ? and award_id = ?', [farther_uid, farther_award_id]);
        if (farther_award_rows.length < 10) {
            // 更新父用户奖励
            let farther_bonus_points = 100;
            let farther_remark = `[邀请他人奖励] 被邀请者uid[${uid}] 奖励积分[${farther_bonus_points}]`;
            let farther_award_record_data = {uid: farther_uid, award_id: farther_award_id, remark: farther_remark};
            await box_db_con.query('insert into award_record set ?', farther_award_record_data);
            // 更新积分
            await box_db_con.query('update user_points set remain = remain + ? where uid = ?', [farther_bonus_points, farther_uid]);
            // 插入积分记录
            let farther_points_record_data = {
                uid: farther_uid,
                record_type: 1,
                num: farther_bonus_points,
                remark: farther_remark,
            }
            await box_db_con.query('insert into points_record set ?', farther_points_record_data);
        }

        res.json({
            success: true,
            result: 'ok',
            msg: remark
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 活动密令兑换
router.post('/award_code', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let code = req.body.code || '';
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        let [user_info_rows] = await box_db_con.query('select phone from user_info where uid = ?', uid);
        // 判断是否绑定手机号
        if (!user_info_rows[0].phone) {
            throw Error('兑换密令需要您先前往设置绑定手机号!');
        }

        // 检查award_task 是否存在该奖励活动 award_id
        let award_id = code;
        let [award_task_rows] = await box_db_con.query('select * from award_task where award_id = ? and start_time <= ? and end_time >= ?', [award_id, new Date(), new Date()]);
        if (award_task_rows.length === 0) {
            throw Error('无效的密令');
        }
        // 检查该用户是否已经领取过该奖励
        let [award_record_rows] = await box_db_con.query('select rid from award_record where uid = ? and award_id = ?', [uid, award_id]);
        if (award_record_rows.length > 0) {
            throw Error('您已经领取过该奖励');
        }
        // 更新奖励记录
        let bonus_points = award_task_rows[0].bonus_points;
        let bonus_name = award_task_rows[0].name;
        let remark = `[${bonus_name}] 奖励积分[${bonus_points}]`;
        let award_record_data = {uid, award_id, remark};
        await box_db_con.query('insert into award_record set ?', award_record_data);
        // 更新积分
        await box_db_con.query('update user_points set remain = remain + ? where uid = ?', [bonus_points, uid]);
        // 插入积分记录
        let points_record_data = {
            uid,
            record_type: 1,
            num: bonus_points,
            remark,
        }
        await box_db_con.query('insert into points_record set ?', points_record_data);

        res.json({
            success: true,
            result: remark,
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 观看激励广告
router.post('/create_reward_ad', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    try {
        let action_obj = new action(uid, 'create_reward_ad', 'reward_ad');
        await action_obj.init();
        // 进行频率检测
        await action_obj.check();

        // 查询今天用户观看成功了多少广告，超过五个则不允许
        let box_db_con = await mysql_obj.connect('steam_box');
        let [reward_ad_rows] = await box_db_con.query('select reward_ad_id from reward_ad where uid = ? and success = 1 and date(create_time) = curdate()', uid);

        if (reward_ad_rows.length >= activity_config().reward_ad.limit) {
            throw Error('今日观看广告次数已达上限');
        }
        // 创建广告记录
        let [insert_rows] = await box_db_con.query('insert into reward_ad set ?', {uid});
        let reward_ad_id = insert_rows.insertId;
        await action_obj.update(10);
        res.json({
            success: true,
            result: {
                userId: uid.toString(),
                extra: reward_ad_id.toString(),
            }
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 检查激励广告
router.post('/check_reward_ad', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let reward_ad_id = req.body.reward_ad_id || (() => {
        throw Error('缺少必填参数')
    })();
    try {
        // 查询该广告是否成功
        let box_db_con = await mysql_obj.connect('steam_box');
        let [reward_ad_rows] = await box_db_con.query('select remark from reward_ad where reward_ad_id = ? and success = 1 and uid = ?', [reward_ad_id, uid]);
        if (reward_ad_rows.length === 0) {
            throw Error('[失败] 广告未观看成功或奖励有延迟，请稍后查看积分记录');
        }
        let remark = reward_ad_rows[0].remark;
        res.json({
            success: true,
            result: remark
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

