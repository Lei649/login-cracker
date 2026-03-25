# Tesseract.js 安装说明

本目录用于存放 Tesseract.js 库文件，启用自动验证码 OCR 识别功能。

## 安装方法

### 方法一：npm 下载

```bash
npm install tesseract.js
```

然后将以下文件复制到本目录 (`lib/`)：

- `node_modules/tesseract.js/dist/tesseract.min.js`

### 方法二：CDN 直接下载

访问以下地址，另存为到本目录：

```
https://unpkg.com/tesseract.js/dist/tesseract.min.js
```

## 安装完成后

目录结构应如下：

```
lib/
├── README.md              ← 本文件
└── tesseract.min.js       ← Tesseract.js 主文件
```

重新加载扩展后，插件会自动检测并启用 OCR 模式。
设置页面的 "OCR 状态" 会显示 "Tesseract.js 已加载"。

## 不安装 Tesseract.js

如果不安装，插件将使用 **手动输入验证码** 模式：
每次尝试时会显示验证码图片，用户手动输入验证码内容后继续。
