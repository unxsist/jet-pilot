const template = `apiVersion: batch/v1
kind: CronJob
metadata:
  creationTimestamp: null
  name: new-cronjob
  namespace: default
spec:
  jobTemplate:
    metadata:
      creationTimestamp: null
      name: new-cronjob
    spec:
      template:
        metadata:
          creationTimestamp: null
        spec:
          containers:
          - image: busybox
            name: new-cronjob
          restartPolicy: OnFailure
  schedule: '*/1 * * * *'
`;

export default template;
