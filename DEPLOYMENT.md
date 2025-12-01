# VR 机器人控制项目 - Nginx 部署指南

## 📋 部署步骤

### 1️⃣ 前置准备

确保已完成：
- ✅ 项目已构建（`npm run build`）- 生成 `dist` 目录
- ✅ 已安装 Nginx
- ✅ SSL 证书文件存在（`server.crt` 和 `server.key`）

### 2️⃣ Nginx 配置

#### Windows 系统：

1. **找到 Nginx 配置文件**
   - 通常在 `C:\nginx\conf\nginx.conf`
   - 或者 `nginx安装目录\conf\nginx.conf`

2. **编辑 nginx.conf**
   ```bash
   # 打开 nginx.conf，在 http 块中添加：
   include E:/XT/vr-robot-control/nginx.conf;
   ```
   
   或者**直接替换** `nginx.conf` 的 server 配置块为项目中的 `nginx.conf` 内容

3. **修改配置文件中的路径**
   - 确认 `root` 路径正确：`E:/XT/vr-robot-control/dist`
   - 确认证书路径正确：
     ```nginx
     ssl_certificate     E:/XT/vr-robot-control/server.crt;
     ssl_certificate_key E:/XT/vr-robot-control/server.key;
     ```

4. **测试配置**
   ```cmd
   cd C:\nginx
   nginx -t
   ```

5. **启动/重启 Nginx**
   ```cmd
   # 首次启动
   nginx
   
   # 重新加载配置
   nginx -s reload
   
   # 停止
   nginx -s stop
   ```

#### Linux 系统：

1. **复制配置文件**
   ```bash
   sudo cp nginx.conf /etc/nginx/sites-available/vr-robot-control
   sudo ln -s /etc/nginx/sites-available/vr-robot-control /etc/nginx/sites-enabled/
   ```

2. **修改配置中的路径为 Linux 路径**
   ```nginx
   root /home/user/vr-robot-control/dist;
   ssl_certificate     /home/user/vr-robot-control/server.crt;
   ssl_certificate_key /home/user/vr-robot-control/server.key;
   access_log /home/user/vr-robot-control/logs/access.log;
   error_log /home/user/vr-robot-control/logs/error.log;
   ```

3. **测试并重启**
   ```bash
   sudo nginx -t
   sudo systemctl reload nginx
   ```

### 3️⃣ 防火墙配置

**Windows 防火墙：**
```powershell
# 允许 443 端口（HTTPS）
netsh advfirewall firewall add rule name="Nginx HTTPS" dir=in action=allow protocol=TCP localport=443

# 允许 80 端口（HTTP 重定向）
netsh advfirewall firewall add rule name="Nginx HTTP" dir=in action=allow protocol=TCP localport=80
```

**Linux 防火墙：**
```bash
sudo ufw allow 443/tcp
sudo ufw allow 80/tcp
sudo ufw reload
```

### 4️⃣ 获取服务器 IP 地址

**Windows：**
```cmd
ipconfig
```
找到 `IPv4 地址`，例如：`192.168.1.100`

**Linux：**
```bash
ip addr show
# 或
ifconfig
```

---

## 📱 HTC VIVE Focus 3 访问指南

### 步骤 1：确保设备在同一网络

- PC 服务器和 HTC VIVE Focus 3 必须连接到**同一个 Wi-Fi 网络**
- 记录 PC 的 IP 地址（如 `192.168.1.100`）

### 步骤 2：信任自签名证书（重要！）

由于使用自签名 SSL 证书，需要在 VR 头显中信任该证书：

1. **在 HTC VIVE Focus 3 上打开浏览器**
   - 使用内置的浏览器或安装 Firefox Reality / Wolvic

2. **访问服务器地址**
   ```
   https://192.168.1.100
   ```
   （替换为你的实际 IP）

3. **处理证书警告**
   - 会看到 "此连接不安全" 或 "Your connection is not private" 警告
   - 点击 **"高级"** 或 **"Advanced"**
   - 点击 **"继续访问"** 或 **"Proceed to site"**
   - 某些浏览器可能需要输入 `thisisunsafe` 来绕过警告

### 步骤 3：进入 VR 模式

1. 页面加载后，会看到机器人模型
2. 点击右下角的 **"ENTER VR"** 按钮（VR 头显图标）
3. 允许浏览器访问 VR 设备
4. 进入沉浸式 VR 体验

### 步骤 4：使用手柄控制

- **右手手柄**：控制机器人右手
  - 手柄位置 → 机器人手部位置
  - 手柄旋转 → 机器人手部旋转

- **扳机键（Trigger）**：移动机器人
  - 按住扳机 → 机器人瞬移到准星位置

---

## 🔧 故障排查

### 问题 1：无法访问网站

**检查项：**
```cmd
# 1. 检查 Nginx 是否运行
tasklist | findstr nginx

# 2. 检查端口是否被占用
netstat -ano | findstr :443

# 3. 测试本地访问
curl -k https://localhost
```

**解决方案：**
- 确保 Nginx 已启动：`nginx`
- 检查防火墙是否允许 443 端口
- 查看 Nginx 错误日志：`E:\XT\vr-robot-control\logs\error.log`

### 问题 2：证书错误

**症状：** VR 浏览器显示 "NET::ERR_CERT_AUTHORITY_INVALID"

**解决方案：**
- 点击 "高级" → "继续访问"
- 或在 PC 浏览器中先访问一次，添加例外

### 问题 3：模型加载失败

**检查：**
- 确认 `dist/models/RobotExpressive.glb` 文件存在
- 检查 Nginx 配置中 GLB 文件的 MIME 类型设置
- 查看浏览器控制台错误（F12）

### 问题 4："ENTER VR" 按钮不显示

**可能原因：**
- 浏览器不支持 WebXR（尝试 Firefox Reality）
- 没有使用 HTTPS 连接
- VR 设备未正确识别

**解决方案：**
- 确保使用 `https://` 协议
- 在 VR 头显的设置中检查权限
- 尝试其他支持 WebXR 的浏览器

---

## 📊 验证清单

部署完成后，按以下步骤验证：

- [ ] PC 浏览器访问 `https://localhost` 能看到机器人
- [ ] 其他设备访问 `https://192.168.1.x` 能看到机器人
- [ ] HTC VIVE Focus 3 访问能看到页面
- [ ] 点击 "ENTER VR" 能进入 VR 模式
- [ ] 手柄能控制机器人手部
- [ ] 扳机键能移动机器人

---

## 🚀 生产环境建议

如果要在生产环境使用，建议：

1. **使用正式域名和 CA 签发的 SSL 证书**
   - 从 Let's Encrypt 免费获取证书
   - 避免证书警告问题

2. **优化性能**
   ```nginx
   # 启用 HTTP/2
   listen 443 ssl http2;
   
   # 调整 worker 进程
   worker_processes auto;
   ```

3. **添加访问控制**
   ```nginx
   # 限制访问 IP
   allow 192.168.1.0/24;
   deny all;
   ```

4. **监控和日志**
   - 定期检查 `logs/access.log` 和 `logs/error.log`
   - 使用 logrotate 管理日志文件

---

## 📞 技术支持

遇到问题？检查：
- Nginx 错误日志：`E:\XT\vr-robot-control\logs\error.log`
- 浏览器控制台（F12）
- HTC VIVE Focus 3 浏览器开发者工具

祝部署顺利！🎉
