/** An S3 error response: the code, HTTP status and message S3 itself sends. */
export class S3Error extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const noSuchBucket = () => new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist');
export const noSuchKey = () => new S3Error('NoSuchKey', 404, 'The specified key does not exist.');
export const noSuchUpload = () =>
  new S3Error('NoSuchUpload', 404, 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.');
export const malformedXml = () =>
  new S3Error('MalformedXML', 400, 'The XML you provided was not well-formed or did not validate against our published schema.');
export const badDigest = (what: string) => new S3Error('BadDigest', 400, `The ${what} you specified did not match the calculated checksum.`);
export const incompleteBody = () =>
  new S3Error('IncompleteBody', 400, 'You did not provide the number of bytes specified by the Content-Length HTTP header.');
