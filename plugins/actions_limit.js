/*
 * @Author: luyu
 * @Date: 2022-04-18 11:38:52
 * @LastEditors: luyu
 * @LastEditTime: 2022-06-19 18:04:23
 * @FilePath: /steam-box-server/plugins/actions_limit.js
 * @Description: 限制操作频率
 */

// redis
const redis = require('redis');

class Action {
    /**
     * @description: 构造 action 对象，以对 action 进行限制
     * @param {*} key redis key
     * @param {*} action_name 操作名称
     * @param {*} params 附加参数如 steam_id、steam_uname
     * @return {*}
     */
    constructor(key, action_name, params, db = 0) {
        this.key = `${key}`;
        this.action_name = action_name;
        this.params = params;
        this.db = db;
        // 初始化限制时间
        switch (action_name) {
            case 'toggle_bot':
                this.limit_time = 30;
                break;
            case 'update_my_game':
                this.limit_time = 600;
                break;
            case 'achi_list':
            case 'update_game_achi':
                this.limit_time = 10;
                break;
            default:
                this.limit_time = 60;
                break;
        }
    }

    async init() {
        this.rd_con = redis.createClient({
            url: `redis://127.0.0.1:6379/${this.db}`
        });
        this.rd_con.on('error', (err) => { throw err });
    }

    async check() {
        // 取值
        await this.rd_con.connect();
        const expire = await this.rd_con.hGet(this.key, `${this.action_name}:${this.params}`);
        if (expire && expire - Date.now() > 0) {
            throw Error(`[操作频率限制]请在${Math.ceil((expire - Date.now()) / 1000)}秒后重试!`)
        }
        await this.rd_con.quit();
        return true
    }

    async update(limit_time = this.limit_time) {
        await this.rd_con.connect();
        await this.rd_con.hSet(this.key, `${this.action_name}:${this.params}`, Date.now() + limit_time * 1000);
        await this.rd_con.quit();
        return true
    }
}

module.exports = Action;