# 本地探针

将工具返回值作为数据填入模板，禁止将来自日志的文本执行为代码。
每一轮配置和 marker 都是新的；先核对旧块指纹并移除，再插入新块。HTTP token 仅写入临时探针，清理后不得留在交付代码中。

## JS / TS：浏览器与 Node 22
保持日志发送不阻塞业务。仅忽略采集错误，不包住业务代码。
浏览器先把实际页面 origin 加入 begin_run.allowedOrigins；不使用 * 或 null。
模板中的 DATA 只选择少数非敏感标量；为事件添加唯一 id 可帮助去重。

~~~js
// runtime-debug:UNIQUE-MARKER:begin
void fetch(ENDPOINT, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'X-Debug-Token': TOKEN},
  body: JSON.stringify({sessionId: SESSION_ID, runId: RUN_ID, hypothesisId: 'H1',
    location: 'relative/file.ts:function', message: 'specific observation',
    data: DATA, timestamp: Date.now()})
}).catch(() => {});
// runtime-debug:UNIQUE-MARKER:end
~~~

Node 测试脚本需要等待探针请求完成后再退出；不要为了发送日志让真实业务函数额外等待。
HTTP 单条上限 64 KiB，每轮上限 20 MiB；工具拒绝超限请求，出现错误时应减少观测范围并开始新轮次。
没有日志时检查资源重载、实际执行路径与采集错误；不能仅用手工 HTTP 请求冒充业务探针证据。

## Python
用工具返回的绝对 logPath；Windows 路径应通过 JSON 字符串序列化或 Python repr 正确转义。以下异常处理仅限日志文件写入。

~~~python
# runtime-debug:UNIQUE-MARKER:begin
try:
    import json as _rd_json, time as _rd_time
    with open(LOG_PATH, "a", encoding="utf-8") as _rd_file:
        _rd_file.write(_rd_json.dumps({"sessionId": SESSION_ID, "runId": RUN_ID,
            "hypothesisId": "H1", "location": "relative/file.py:function",
            "message": "specific observation", "data": DATA,
            "timestamp": int(_rd_time.time() * 1000)}) + "\n")
except OSError:
    pass
# runtime-debug:UNIQUE-MARKER:end
~~~

Python 直接写入日志的内容在 read_logs 时校验和脱敏；原始文件仍可能含敏感内容，源头必须最小化。
直接写入不会由 HTTP 服务限制体积；自行控制频率与大小，read_logs 对超过 20 MiB 的文件会拒绝读取。
其他语言尚未验收，不声明已支持。
