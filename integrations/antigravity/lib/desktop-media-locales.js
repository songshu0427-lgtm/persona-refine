// Runtime diagnostics: the wire does not carry the client's UI language, so the computer's locale applies.
export default {
  en: {
    empty: 'Add a message or an image before sending.',
    missing: 'This image is no longer available on the computer.',
    invalid: 'The image data is invalid or does not match its format. Attach the image again.',
    count: 'Send up to 4 images at a time.',
    large: 'Each image must be no larger than 8 MB.',
    type: 'Use a PNG, JPEG, GIF or WebP image.',
    model: 'The selected model does not support images. Choose a model that can read images.',
    modelType: 'The selected model does not support this image format. Choose another image or model.',
  },
  'zh-Hans': {
    empty: '请先输入消息或添加图片。',
    missing: '电脑上的这张图片已不可用。',
    invalid: '图片数据无效或与格式不符，请重新添加图片。',
    count: '每次最多发送 4 张图片。',
    large: '每张图片不能超过 8 MB。',
    type: '请使用 PNG、JPEG、GIF 或 WebP 图片。',
    model: '当前模型不支持图片，请切换到能识别图片的模型。',
    modelType: '当前模型不支持这种图片格式，请更换图片或模型。',
  },
  ja: {
    empty: 'メッセージを入力するか、画像を追加してください。',
    missing: 'この画像はコンピューター上で利用できなくなりました。',
    invalid: '画像データが無効か、形式と一致しません。画像を添付し直してください。',
    count: '一度に送信できる画像は4枚までです。',
    large: '画像は1枚8MB以下にしてください。',
    type: 'PNG、JPEG、GIFまたはWebP画像を使用してください。',
    model: '選択したモデルは画像に対応していません。画像を読み取れるモデルを選択してください。',
    modelType: '選択したモデルはこの画像形式に対応していません。別の画像またはモデルを選択してください。',
  },
}
