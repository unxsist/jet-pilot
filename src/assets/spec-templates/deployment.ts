const template = `apiVersion: apps/v1
kind: Deployment
metadata:
  creationTimestamp: null
  labels:
    app: new-deployment
  name: new-deployment
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: new-deployment
  template:
    metadata:
      creationTimestamp: null
      labels:
        app: new-deployment
    spec:
      containers:
      - image: image:latest
        name: image
`;

export default template;
