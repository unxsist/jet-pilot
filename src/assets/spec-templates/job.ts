const template = `apiVersion: batch/v1
kind: Job
metadata:
  creationTimestamp: null
  name: new-job
  namespace: default
spec:
  template:
    metadata:
      creationTimestamp: null
    spec:
      containers:
      - image: busybox
        name: new-job
      restartPolicy: Never
`;

export default template;
